import net from 'net';
import tls from 'tls';

type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  timeoutMs?: number;
};

function encode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function dotStuff(text: string) {
  return text.replace(/(^|\r?\n)\./g, '$1..').replace(/\r?\n/g, '\r\n');
}

function waitForResponse(socket: net.Socket | tls.TLSSocket, expected: number[]) {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      if (!expected.includes(code)) reject(new Error(`SMTP error ${code}: ${buffer.trim()}`));
      else resolve(buffer);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onTimeout = () => { cleanup(); reject(new Error('SMTP connection timed out')); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
  });
}

async function command(socket: net.Socket | tls.TLSSocket, value: string, expected: number[]) {
  socket.write(`${value}\r\n`);
  return waitForResponse(socket, expected);
}

export async function sendSmtpMail(options: SmtpOptions) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  let activeSocket: net.Socket | tls.TLSSocket = options.secure
    ? tls.connect({ host: options.host, port: options.port, servername: options.host })
    : net.connect({ host: options.host, port: options.port });
  activeSocket.setTimeout(timeoutMs);
  // Bound the whole SMTP conversation, not every command independently. Without
  // this guard a silent relay can consume one full socket timeout per protocol
  // step and leave a paid Stripe event unacknowledged for several minutes.
  const deadline = setTimeout(() => activeSocket.destroy(new Error('SMTP delivery timed out')), timeoutMs);

  try {
    await waitForResponse(activeSocket, [220]);
    await command(activeSocket, `EHLO qyroam.com`, [250]);

    if (!options.secure && options.port === 587) {
      await command(activeSocket, 'STARTTLS', [220]);
      activeSocket = tls.connect({ socket: activeSocket, servername: options.host });
      activeSocket.setTimeout(timeoutMs);
      await command(activeSocket, 'EHLO qyroam.com', [250]);
    }

    await command(activeSocket, 'AUTH LOGIN', [334]);
    await command(activeSocket, encode(options.user), [334]);
    await command(activeSocket, encode(options.pass), [235]);
    await sendMessage(activeSocket, options);
  } finally {
    clearTimeout(deadline);
    activeSocket.destroy();
  }
}

async function sendMessage(socket: net.Socket | tls.TLSSocket, options: SmtpOptions) {
  await command(socket, `MAIL FROM:<${options.from}>`, [250]);
  await command(socket, `RCPT TO:<${options.to}>`, [250, 251]);
  await command(socket, 'DATA', [354]);

  const message = [
    `From: QY Roam <${options.from}>`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(options.text),
    '.'
  ].join('\r\n');
  socket.write(`${message}\r\n`);
  await waitForResponse(socket, [250]);
  await command(socket, 'QUIT', [221]);
}

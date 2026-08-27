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
  const socket = options.secure
    ? tls.connect({ host: options.host, port: options.port, servername: options.host })
    : net.connect({ host: options.host, port: options.port });
  socket.setTimeout(15000);

  await waitForResponse(socket, [220]);
  await command(socket, `EHLO qyroam.com`, [250]);

  if (!options.secure && options.port === 587) {
    await command(socket, 'STARTTLS', [220]);
    const secureSocket = tls.connect({ socket, servername: options.host });
    secureSocket.setTimeout(15000);
    await command(secureSocket, 'EHLO qyroam.com', [250]);
    await command(secureSocket, 'AUTH LOGIN', [334]);
    await command(secureSocket, encode(options.user), [334]);
    await command(secureSocket, encode(options.pass), [235]);
    await sendMessage(secureSocket, options);
    secureSocket.end();
    return;
  }

  await command(socket, 'AUTH LOGIN', [334]);
  await command(socket, encode(options.user), [334]);
  await command(socket, encode(options.pass), [235]);
  await sendMessage(socket, options);
  socket.end();
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

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
  // A stable id lets a relay or mailbox collapse a retry that occurs after it
  // accepted DATA but before the application could durably record success.
  // It is deliberately optional for general SMTP callers.
  messageId?: string;
  timeoutMs?: number;
};

// Fulfilment delivery is retried independently from checkout, including for
// sessions created before a deployment changes its environment validation.
// Keep the transport boundary defensive as well: these values are interpolated
// into SMTP envelope commands and message headers, so trimming alone is not a
// sufficient safeguard against malformed configuration or header injection.
export function isSafeSmtpMailbox(value: string | undefined) {
  return Boolean(value && value.length <= 254 && /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(value));
}

function normalizedMailbox(value: string, field: 'from' | 'to') {
  const mailbox = value.trim();
  if (!isSafeSmtpMailbox(mailbox)) throw new Error(`Invalid SMTP ${field} mailbox`);
  return mailbox;
}

// Keep this export available to the pre-payment readiness gate. A host that
// the transport would reject must make checkout unavailable before Stripe can
// accept a paid order, rather than first failing when its fulfilment alert is
// sent after payment.
export function isSafeSmtpHost(value: string | undefined) {
  if (!value) return false;
  const host = value.trim();
  return Boolean(host && host.length <= 253 && !/[\s\r\n]/.test(host));
}

function safeSmtpHost(value: string) {
  if (!isSafeSmtpHost(value)) throw new Error('Invalid SMTP host');
  const host = value.trim();
  return host;
}

function safeSmtpSubject(value: string) {
  if (!value || value.length > 998 || /[\r\n]/.test(value)) throw new Error('Invalid SMTP subject');
  return value;
}

function encode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function dotStuff(text: string) {
  return text.replace(/(^|\r?\n)\./g, '$1..').replace(/\r?\n/g, '\r\n');
}

function safeMessageId(value: string | undefined) {
  // Message-ID is a header value, so reject rather than interpolate any value
  // that could introduce a second header. The webhook generates this value
  // from a Stripe session id; this guard keeps the low-level SMTP helper safe
  // for future callers too.
  return value && /^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(value) ? value : null;
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
      // SMTP responses come from an external service and flow into the
      // durable fulfilment retry ledger when delivery fails. Keep the
      // actionable status code, but never retain or log the response text:
      // a misconfigured or hostile relay can echo envelope details or other
      // sensitive request context in an error banner.
      if (!expected.includes(code)) reject(new Error(`SMTP error ${code}`));
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
  const host = safeSmtpHost(options.host);
  const from = normalizedMailbox(options.from, 'from');
  const to = normalizedMailbox(options.to, 'to');
  const subject = safeSmtpSubject(options.subject);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid SMTP port');
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Invalid SMTP timeout');
  const safeOptions = { ...options, host, from, to, subject };
  let activeSocket: net.Socket | tls.TLSSocket = options.secure
    ? tls.connect({ host, port: options.port, servername: host })
    : net.connect({ host, port: options.port });
  activeSocket.setTimeout(timeoutMs);
  // Bound the whole SMTP conversation, not every command independently. Without
  // this guard a silent relay can consume one full socket timeout per protocol
  // step and leave a paid Stripe event unacknowledged for several minutes.
  const deadline = setTimeout(() => activeSocket.destroy(new Error('SMTP delivery timed out')), timeoutMs);

  try {
    await waitForResponse(activeSocket, [220]);
    await command(activeSocket, `EHLO qyroam.com`, [250]);

    // A paid-order message contains customer contact and fulfilment details.
    // Never authenticate or send it over a cleartext SMTP connection merely
    // because an operator uses a submission port other than the conventional
    // 587 (many relays use 25 or 2525). Implicit-TLS transports are already
    // protected by tls.connect above; every other transport must upgrade with
    // STARTTLS before AUTH or DATA. A relay without STARTTLS fails closed and
    // leaves the durable delivery record retryable rather than leaking PII.
    if (!options.secure) {
      await command(activeSocket, 'STARTTLS', [220]);
      activeSocket = tls.connect({ socket: activeSocket, servername: host });
      activeSocket.setTimeout(timeoutMs);
      await command(activeSocket, 'EHLO qyroam.com', [250]);
    }

    await command(activeSocket, 'AUTH LOGIN', [334]);
    await command(activeSocket, encode(options.user), [334]);
    await command(activeSocket, encode(options.pass), [235]);
    await sendMessage(activeSocket, safeOptions);
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
    ...(safeMessageId(options.messageId) ? [`Message-ID: ${safeMessageId(options.messageId)}`] : []),
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

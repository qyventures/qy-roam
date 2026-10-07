export const CUSTOMER_REQUEST_TIMEOUT_MS = 120_000;

export class CustomerRequestTimeoutError extends Error {
  constructor() {
    super('QY Roam request timed out');
    this.name = 'CustomerRequestTimeoutError';
  }
}

type CustomerJsonResponse = {
  response: Response;
  value: unknown;
};

async function runCustomerRequest<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Invalid customer request timeout');
  }

  const controller = new AbortController();
  const callerSignal = init.signal;
  let rejectDeadline: ((reason: Error) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const abortFromCaller = () => {
    const reason = callerSignal?.reason instanceof Error
      ? callerSignal.reason
      : new Error('Customer request cancelled');
    controller.abort(reason);
    rejectDeadline?.(reason);
  };
  const timeoutError = new CustomerRequestTimeoutError();
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
    // Race explicitly as well as aborting fetch and response consumption:
    // some browser/network edge cases do not settle either promise promptly
    // after signal cancellation.
    rejectDeadline?.(timeoutError);
  }, timeoutMs);

  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const operation = fetch(input, { ...init, signal: controller.signal })
      .then(consume);
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
    rejectDeadline = undefined;
  }
}

// Customer requests can legitimately span several bounded Stripe and
// persistence calls. Give the server its full reviewed proxy window, but do
// not leave the storefront disabled forever when a mobile connection drops
// without closing its fetch. The checkout attempt id is retained by callers,
// so retrying after this timeout remains idempotent.
export async function fetchCustomerRequest(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = CUSTOMER_REQUEST_TIMEOUT_MS,
) {
  return runCustomerRequest(input, init, timeoutMs, async (response) => response);
}

// Storefront callers need the deadline to cover the complete response, not
// only receipt of its headers. A proxy or mobile peer can return headers and
// then stall the JSON body; clearing the timer at that point would leave the
// checkout button disabled forever. Keep parsing inside the same abortable,
// explicitly raced operation and return the Response metadata separately for
// the existing status-aware envelope validators.
export async function fetchCustomerJson(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = CUSTOMER_REQUEST_TIMEOUT_MS,
): Promise<CustomerJsonResponse> {
  return runCustomerRequest(input, init, timeoutMs, async (response) => ({
    response,
    value: await response.json() as unknown,
  }));
}

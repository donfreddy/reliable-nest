/**
 * `LISTEN`/`NOTIFY` channel names are SQL identifiers embedded directly in
 * the statement text (unlike `pg_notify(channel, payload)`, whose channel
 * argument IS a bindable parameter). `client.query('LISTEN ' + channel)`
 * has no parameterized form, so the channel must be validated before it
 * ever reaches SQL text.
 */
const VALID_CHANNEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function assertValidChannelName(channel: string): void {
  if (!VALID_CHANNEL.test(channel)) {
    throw new Error(
      `Invalid LISTEN/NOTIFY channel name "${channel}": must match ${VALID_CHANNEL} ` +
        `(SQL identifier characters only, no quoting, since it is embedded directly in SQL text).`,
    );
  }
}

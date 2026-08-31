/**
 * The `resp_<uuid>` id clients address a response by. Presentation only: the database stores the
 * uuid, so the prefix is applied on the way out and stripped on the way in.
 */

const RESPONSE_ID_PREFIX = "resp_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatResponseId(uuid: string): string {
  return `${RESPONSE_ID_PREFIX}${uuid}`;
}

/** The uuid an id names, or null when it is anything else. */
export function parseResponseId(id: string): string | null {
  if (!id.startsWith(RESPONSE_ID_PREFIX)) {
    return null;
  }
  const uuid = id.slice(RESPONSE_ID_PREFIX.length);
  return UUID.test(uuid) ? uuid : null;
}

export function newResponseId(): string {
  return formatResponseId(crypto.randomUUID());
}

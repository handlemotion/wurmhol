// Machines (ADR 0018): `wurmhol host` keeps one WebSocket to the relay, reports the web ports open
// on its computer, and opens a pipe to one when its owner asks from the wall. The CLI sends
// `HostMessage`s and reads `RelayMessage`s; the Worker does the reverse, and pushes
// `MachinesEvent`s to the owner's open Create pipe cards.

/** The highest TCP port, for schemas that state the range. */
export const MAX_PORT = 65_535;

/** A TCP port number: an integer from 1 to `MAX_PORT`. */
export function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PORT;
}

/** What a computer is called when its CLI sends no usable name. */
export const DEFAULT_COMPUTER_NAME = "Computer";
export const COMPUTER_NAME_MAX = 80;

/** `value` as a computer's name, trimmed, or null when it cannot be one. */
export function computerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= COMPUTER_NAME_MAX ? name : null;
}

/** Bounds on what a machine sends, so one cannot fill the Org object's memory. */
export const MACHINE_LIMITS = { ports: 64, title: 200, id: 64, url: 2048, message: 500 } as const;

/** A local port a machine reports: a web server answering on it, and its page's `<title>`. */
export interface MachinePort {
  port: number;
  title: string | null;
}

/** A running `wurmhol host`, as its owner's Create pipe card lists it. */
export interface Machine {
  id: string;
  /** The computer's name, as the CLI reports it. */
  name: string;
  ports: MachinePort[];
  connectedAt: number;
}

/** What the Org object sends to its owner's open Create pipe cards. */
export type MachinesEvent = { type: "machines"; machines: Machine[] };

/** The relay asks the machine to open a pipe to one of the ports it reported. */
export type RelayMessage = { type: "open"; id: string; port: number };

/** What `wurmhol host` sends: its ports, or the answer to the `open` with the same id. */
export type HostMessage =
  | { type: "ports"; ports: MachinePort[] }
  | { type: "opened"; id: string; url: string }
  | { type: "failed"; id: string; message: string };

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isMachinePort(value: unknown): value is MachinePort {
  if (typeof value !== "object" || value === null) return false;
  const { port, title } = value as Record<string, unknown>;
  return isPort(port) && (title === null || boundedString(title, MACHINE_LIMITS.title));
}

/** The wall shows the URL as a link, so only http(s). */
function isHttpUrl(value: unknown): value is string {
  if (!boundedString(value, MACHINE_LIMITS.url)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** A machine's message as the relay accepts it, or null when it is not one. */
export function parseHostMessage(raw: unknown): HostMessage | null {
  const m = asRecord(raw);
  if (!m) return null;
  if (m.type === "ports") {
    const ports: unknown = m.ports;
    if (!Array.isArray(ports) || ports.length > MACHINE_LIMITS.ports) return null;
    if (!ports.every(isMachinePort)) return null;
    return { type: "ports", ports: ports.map(({ port, title }) => ({ port, title })) };
  }
  if (!boundedString(m.id, MACHINE_LIMITS.id)) return null;
  if (m.type === "opened") {
    return isHttpUrl(m.url) ? { type: "opened", id: m.id, url: m.url } : null;
  }
  if (m.type === "failed") {
    return boundedString(m.message, MACHINE_LIMITS.message)
      ? { type: "failed", id: m.id, message: m.message }
      : null;
  }
  return null;
}

/** The relay's message as the machine accepts it, or null when it is not one. */
export function parseRelayMessage(raw: unknown): RelayMessage | null {
  const m = asRecord(raw);
  return m?.type === "open" && typeof m.id === "string" && isPort(m.port)
    ? { type: "open", id: m.id, port: m.port }
    : null;
}

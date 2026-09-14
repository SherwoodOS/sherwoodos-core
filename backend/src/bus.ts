import type { ActivityRow, MessageRow, PaymentRow } from "./db.ts";

export type AgentStatus = "WORKING" | "THINKING" | "WAITING" | "PAYING" | "IDLE";

export type BusEvent =
  | { type: "activity"; data: ActivityRow }
  | { type: "message"; data: MessageRow }
  | { type: "payment"; data: PaymentRow }
  | { type: "status"; data: { agentId: string; status: AgentStatus; task: string | null; taskId: string | null } }
  | { type: "balance"; data: { agentId: string; balance: string; spentToday: string } }
  | { type: "system"; data: { text: string } };

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
let seq = 0;
const recent: { id: number; e: BusEvent }[] = [];

export const bus = {
  emit(e: BusEvent) {
    seq += 1;
    recent.push({ id: seq, e });
    if (recent.length > 200) recent.shift();
    for (const l of listeners) {
      try {
        l(e);
      } catch {

      }
    }
  },
  on(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  since(id: number) {
    return recent.filter((r) => r.id > id);
  },
  get seq() {
    return seq;
  },
};

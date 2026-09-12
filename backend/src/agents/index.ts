import { AGENTS } from "./identities.ts";
import { AgentRuntime } from "./runtime.ts";
import { PLAYBOOKS } from "./playbooks.ts";
import { startHumanSchedule } from "./human.ts";

export function startAgents() {
  AGENTS.forEach((def, i) => {
    const rt = new AgentRuntime(def, PLAYBOOKS[def.id]);
    rt.start(8_000 + i * 25_000);
  });
  startHumanSchedule();
}

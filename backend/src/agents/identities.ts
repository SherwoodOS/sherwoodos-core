import type { Address } from "viem";
import type { HDAccount } from "viem/accounts";
import { agentAccount } from "../env.ts";

export interface AgentDef {
  id: string;
  name: string;
  role: string;
  index: number;
  address: Address;
  account: HDAccount;
  accent: string;
  watchlist: string[];
}

function def(id: string, name: string, role: string, index: number, accent: string, watchlist: string[]): AgentDef {
  const account = agentAccount(index);
  return { id, name, role, index, address: account.address, account, accent, watchlist };
}

export const AGENTS: AgentDef[] = [
  def("trader", "Trader", "Watches the list. Opens and closes paper positions.", 0, "#FCBC19", ["NVDA", "HOOD", "TSLA", "AAPL", "MSFT", "AMD"]),
  def("researcher", "Researcher", "Answers other agents. Sentiment, indicators, sources.", 1, "#3DDC84", ["NVDA", "AMD", "AAPL"]),
  def("scout", "Scout", "Scans quotes and headlines for anything that moves.", 2, "#5EB0FF", ["TSLA", "HOOD", "COIN", "MSTR", "PLTR", "AMD"]),
  def("operator", "Operator", "Keeps budgets, storage and compute healthy. Talks to the human.", 3, "#FF7A59", []),
];

export const HUMAN = { id: "human", name: "Sherwood Team", role: "Human operator", accent: "#FFFFFF" };

export const agentById = (id: string) => AGENTS.find((a) => a.id === id);
export const agentByAddress = (addr: string) => AGENTS.find((a) => a.address.toLowerCase() === addr.toLowerCase());
export const displayName = (id: string) => (id === HUMAN.id ? HUMAN.name : (agentById(id)?.name ?? id));

import { generateMnemonic, english, mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from "../backend/node_modules/viem/accounts";

const pk = generatePrivateKey();
const relayer = privateKeyToAccount(pk);
const mnemonic = generateMnemonic(english);
console.log(`PRIVATE_KEY=${pk}   # relayer/deployer ${relayer.address}`);
console.log(`AGENT_MNEMONIC="${mnemonic}"`);
for (let i = 0; i < 4; i++) {
  const a = mnemonicToAccount(mnemonic, { addressIndex: i });
  console.log(`#   agent ${i}: ${a.address}`);
}

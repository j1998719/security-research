import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

async function main() {
  const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
  
  // Get the full transaction that published/upgraded to PROTO_PKG
  // PROTO_PKG is itself a package — let's get its object info
  const pkgInfo = await client.getObject({ 
    id: PROTO_PKG, 
    options: { showStorageRebate: true, showPreviousTransaction: true }
  });
  console.log("PROTO_PKG previousTransaction:", pkgInfo.data?.previousTransaction);
  
  // Get the transaction that created PROTO_PKG to find the upgrade cap
  const prevTx = pkgInfo.data?.previousTransaction;
  if (prevTx) {
    const txDetail = await client.getTransactionBlock({
      digest: prevTx,
      options: { showObjectChanges: true, showInput: true, showEffects: true }
    });
    
    // Look for UpgradeCap in the changes
    const changes = txDetail.objectChanges ?? [];
    for (const ch of changes) {
      if ((ch as any).type === "created" || (ch as any).type === "mutated") {
        const objType = (ch as any).objectType ?? "";
        if (objType.includes("UpgradeCap") || objType.includes("Package")) {
          console.log("Interesting change:", ch);
        }
      }
    }
    
    // Find all created packages
    console.log("\nAll object changes in PROTO_PKG creation tx:");
    for (const ch of changes) {
      const t = (ch as any).type;
      const id = (ch as any).objectId ?? (ch as any).packageId ?? "";
      const objType = (ch as any).objectType ?? "Package";
      if (t && id) {
        console.log(`  ${t}: ${id} [${objType.slice(0, 60)}]`);
      }
    }
  }
  
  // Try querying by package type directly - find latest NAVI packages
  // Look at what type the NAVI Storage object uses
  const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
  const storObj = await client.getObject({ id: STORAGE, options: { showContent: true, showPreviousTransaction: true } });
  const storType = (storObj.data?.content as any)?.type ?? "";
  console.log("\nStorage object type:", storType);
  const storPrevTx = storObj.data?.previousTransaction;
  console.log("Storage previousTransaction:", storPrevTx);
  
  if (storPrevTx) {
    const txDetail = await client.getTransactionBlock({
      digest: storPrevTx,
      options: { showInput: true }
    });
    const prog = (txDetail.transaction?.data?.transaction as any);
    if (prog?.kind === "ProgrammableTransaction") {
      for (const cmd of prog.commands ?? []) {
        if (cmd.MoveCall?.package) {
          console.log("Package in storage-modifying tx:", cmd.MoveCall.package, "::", cmd.MoveCall.module, "::", cmd.MoveCall.function);
        }
      }
    }
  }
}

main().catch(console.error);

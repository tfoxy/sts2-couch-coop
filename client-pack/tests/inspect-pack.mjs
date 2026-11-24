import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const helper = path.join(process.env.COUCHCOOP_GSW_ROOT,
  "experiments/render-stream/scripts/lib/godot-pck.ts");
const { listPck, pckEntryBytes } = await import(pathToFileURL(helper).href);
const bytes = fs.readFileSync(process.argv[2]);
const listing = listPck(bytes);
for (const entry of listing.files) {
  assert(!/\.(so|dll|dylib|wasm|gdextension)$/i.test(entry.path), entry.path);
  const magic = Buffer.from(pckEntryBytes(bytes, listing, entry).subarray(0, 4));
  assert(!["7f454c46", "0061736d"].includes(magic.toString("hex")), entry.path);
  assert(!magic.subarray(0, 2).equals(Buffer.from("MZ")), entry.path);
  assert(!entry.path.startsWith("tests/"), entry.path);
}
assert(listing.files.some(file => file.path === "couch/entry.tscn.remap"));
assert(listing.files.some(file => file.path === "couch/receiver/receiver.gd"));
console.log(JSON.stringify(listing, null, 2));

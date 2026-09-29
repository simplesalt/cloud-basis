import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../DuxSoupEventHandler.js", import.meta.url), "utf8");
const found = source.split("\n").flatMap((line, i) => (/\$\{|%\{/.test(line) ? [i + 1 + ": " + line.trim()] : []));
if (found.length > 0) {
  console.error("DuxSoupEventHandler.js must not contain ${ or %{ (Terraform parses Script content as a template):\n" + found.join("\n"));
  process.exit(1);
}
console.log("check-source: no template sequences");

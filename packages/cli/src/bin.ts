// Entry of the built bundle (dist/mar.mjs): runs main() in-process and exits with its code.
import { main } from "./main.js";

process.exit(await main(process.argv.slice(2)));

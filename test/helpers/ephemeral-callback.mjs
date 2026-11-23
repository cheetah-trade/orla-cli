// Preloaded only by the timeout test's child; production port selection is unchanged.
import { PORTS } from "../../dist/auth.js";

PORTS.splice(0, PORTS.length, 0);

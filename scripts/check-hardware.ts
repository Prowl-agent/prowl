import { detectHardware, formatProfile } from "../packages/core/src/setup/hardware-detect.js";

const profile = await detectHardware();
console.log("=== HARDWARE PROFILE ===");
console.log(formatProfile(profile));
console.log("");
console.log("Raw profile:", JSON.stringify(profile, null, 2));

if (profile.totalRAMGB === 0) {
  throw new Error("FAIL: totalRAMGB is 0 — detection failed");
}
if (profile.os === "unknown") {
  throw new Error("FAIL: OS detected as unknown");
}
if (profile.availableForModelGB === 0) {
  throw new Error("FAIL: availableForModelGB is 0 — memory calc failed");
}

console.log("✅ Hardware detection PASSED");

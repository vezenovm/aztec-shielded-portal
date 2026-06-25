// Ambient declarations for the OPTIONAL real-Tornado proof toolchain. These packages are only
// needed to build a real Tornado withdrawal proof (the Tier 3 rehearsal / production real path);
// the core SDK (mock path, commitment, content hashes) does not depend on them. Declaring them
// here keeps `tsc --noEmit` green when they are not installed -- the functions that use them
// dynamic-import at call time, so a missing package surfaces only when the real path is exercised.
declare module 'snarkjs';
declare module 'circomlibjs';
declare module 'fixed-merkle-tree';

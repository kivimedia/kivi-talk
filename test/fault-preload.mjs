/* Loaded into the bridge with NODE_OPTIONS=--import=<this file> by tests that need the disk to
 * misbehave. TTC_TEST_FAULT picks the fault; nothing happens without it.
 *   enospc:<text>    every write to a file whose path contains <text> fails as a full disk would,
 *                    asynchronously, like a real fs.write.
 *   zerostat:<text>  fs.statSync reports size 0 for a path containing <text>, as Linux does for
 *                    /proc/meminfo and friends (regular files with content and no size).
 */
import fs from "node:fs";

const [kind, needle] = String(process.env.TTC_TEST_FAULT || "").split(/:(.*)/s);

if (kind === "enospc" && needle) {
  const fdPath = new Map();
  const open0 = fs.open;
  fs.open = function (p, flags, mode, cb) {
    if (typeof flags === "function") { cb = flags; flags = undefined; mode = undefined; }
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    return open0.call(fs, p, flags, mode, (err, fd) => { if (!err) fdPath.set(fd, String(p)); cb(err, fd); });
  };
  const fails = (fd) => (fdPath.get(fd) || "").includes(needle);
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  for (const name of ["write", "writev"]) {
    const orig = fs[name];
    fs[name] = function (fd, ...rest) {
      if (!fails(fd)) return orig.call(fs, fd, ...rest);
      const cb = rest.at(-1);
      setTimeout(() => cb(enospc()), 30);
    };
  }
}

if (kind === "zerostat" && needle) {
  const stat0 = fs.statSync;
  fs.statSync = function (p, ...rest) {
    const st = stat0.call(fs, p, ...rest);
    if (st && String(p).includes(needle)) st.size = 0;
    return st;
  };
}

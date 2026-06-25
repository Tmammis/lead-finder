import type { NextConfig } from "next";
import os from "os";
import path from "path";

const nextConfig: NextConfig = {
  distDir: path.join(os.tmpdir(), "lead-finder-dashboard-next"),
};

export default nextConfig;

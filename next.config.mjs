/** @type {import('next').NextConfig} */
const projectDir = process.cwd();
const safeProjectDir = process.env.NEXT_SAFE_PROJECT_DIR || "/tmp/translation-studio-safe";

function rewritePath(value) {
  return typeof value === "string" && value.startsWith(projectDir)
    ? safeProjectDir + value.slice(projectDir.length)
    : value;
}

function rewritePathLike(value) {
  if (typeof value === "string") return rewritePath(value);
  if (Array.isArray(value)) return value.map((item) => rewritePathLike(item));
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const clone = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      clone[key] = rewritePathLike(nestedValue);
    }
    return clone;
  }
  return value;
}

function rewriteIssuerPaths(rules) {
  return rules.map((rule) => {
    if (!rule || typeof rule !== "object") return rule;

    const nextRule = { ...rule };

    for (const key of ["include", "exclude", "path", "root", "resource", "realResource", "test"]) {
      if (key in nextRule) {
        nextRule[key] = rewritePathLike(nextRule[key]);
      }
    }

    if ("issuer" in nextRule) {
      nextRule.issuer = rewritePathLike(nextRule.issuer);
    }

    if (Array.isArray(nextRule.oneOf)) {
      nextRule.oneOf = rewriteIssuerPaths(nextRule.oneOf);
    }

    if (Array.isArray(nextRule.rules)) {
      nextRule.rules = rewriteIssuerPaths(nextRule.rules);
    }

    return nextRule;
  });
}

const nextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://integrate.api.nvidia.com https://generativelanguage.googleapis.com; worker-src 'self' blob:; frame-ancestors 'none';"
          },
          {
            key: "X-Frame-Options",
            value: "DENY"
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff"
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin"
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload"
          }
        ]
      }
    ];
  },
  webpack(config) {
    return {
      ...config,
      context: rewritePath(config.context),
      cache:
        config.cache && typeof config.cache === "object"
          ? { ...config.cache, cacheDirectory: rewritePath(config.cache.cacheDirectory) }
          : config.cache,
      output:
        config.output && typeof config.output === "object"
          ? { ...config.output, path: rewritePath(config.output.path) }
          : config.output,
      module:
        config.module && typeof config.module === "object"
          ? {
              ...config.module,
              rules: Array.isArray(config.module.rules)
                ? rewriteIssuerPaths(config.module.rules)
                : config.module.rules
            }
          : config.module
    };
  }
};

export default nextConfig;

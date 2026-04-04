import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Translation Studio",
    short_name: "Trans Studio",
    description:
      "Professional translation and localization studio for text and JSON with quality refinement.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4fbfa",
    theme_color: "#0d9488",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  };
}

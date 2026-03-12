import { ImageResponse } from "next/og";

export const alt = "Translation Studio";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "70px",
          background:
            "radial-gradient(circle at 10% 10%, #14b8a6 0%, #0d9488 35%, #0f172a 100%)",
          color: "white"
        }}
      >
        <div style={{ fontSize: 78, fontWeight: 800, lineHeight: 1.1 }}>Translation Studio</div>
        <div style={{ marginTop: 20, fontSize: 34, opacity: 0.92 }}>
          Text and JSON localization with quality refinement
        </div>
      </div>
    ),
    size
  );
}

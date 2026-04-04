import { ImageResponse } from "next/og";

export const alt = "Translation Studio";
export const size = {
  width: 1200,
  height: 600
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
          padding: "56px",
          background: "linear-gradient(135deg, #0f172a 0%, #0d9488 65%, #14b8a6 100%)",
          color: "white"
        }}
      >
        <div style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.1 }}>Translation Studio</div>
        <div style={{ marginTop: 18, fontSize: 30, opacity: 0.92 }}>
          Advanced translation and localization workflow
        </div>
      </div>
    ),
    size
  );
}

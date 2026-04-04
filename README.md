# Translation Studio

Next.js (App Router) web app for localization workflows.

## Features
- Text mode pipeline: `translate -> critique -> improve`
- JSON mode pipeline: flattens nested JSON, processes values, rebuilds original structure
- Default provider/model configurable via `.env.local` with safe hardcoded fallback
- Automatic fallback to Gemini Flash when primary AI is unavailable

## Project Structure
- `app/page.tsx`: main UI
- `app/api/translate/route.ts`: server API route
- `lib/llm.ts`: LLM provider calls and 3-step pipeline
- `lib/json.ts`: flatten/unflatten helpers for JSON mode
- `app/globals.css`: global styles

## Prerequisites
- Node.js 20+ (LTS recommended)
- npm 

## Setup
1. Install dependencies:
```bash
npm install
```
2. Create local env file:
```bash
cp .env.example .env.local
```
3. Set required key in `.env.local`:
- `NVIDIA_API_KEY`

Optional envs:
- `NEXT_PUBLIC_DEFAULT_PROVIDER` (default: `gemini`)
- `NEXT_PUBLIC_NVIDIA_MODEL` (default: `stepfun-ai/step-3.5-flash`)
- `NEXT_PUBLIC_GEMINI_MODEL` (default: `gemini-3.1-flash-lite-preview`)
- `NVIDIA_BASE_URL` (default: `https://integrate.api.nvidia.com/v1`)
- `GEMINI_API_KEY` (used when Gemini is primary)
- `GEMINI_FALLBACK_MODEL` (default: `gemini-3.1-flash-lite-preview`)
- `NVIDIA_FALLBACK_MODEL` (default: `stepfun-ai/step-3.5-flash`)

## Development
Run:
```bash
npm run dev
```
Open:
- `http://127.0.0.1:3000`

Note: scripts are configured to bind localhost only (`127.0.0.1`).

## Production Build
```bash
npm run build
npm run start
```

## Change Default Model
Set in `.env.local`:
```bash
NEXT_PUBLIC_DEFAULT_PROVIDER=gemini
NEXT_PUBLIC_NVIDIA_MODEL=stepfun-ai/step-3.5-flash
NEXT_PUBLIC_GEMINI_MODEL=gemini-3.1-flash-lite-preview
```

If these are missing, app falls back to built-in defaults in `app/page.tsx`.

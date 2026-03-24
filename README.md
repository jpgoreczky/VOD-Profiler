# VOD Profiler – DMCA Risk Scanner

A full-stack application that lets streamers scan VODs for copyrighted music.
Upload a video or audio file (or paste a URL) and the app fingerprints the
audio via **ACRCloud**, then returns a detailed breakdown of identified
copyrighted tracks with timestamps and DMCA risk flags.

---

## Tech Stack

| Layer      | Technology                              |
|------------|-----------------------------------------|
| Backend    | Node.js · Express.js                    |
| Deployment | Vercel (Serverless Functions)           |
| Audio ID   | ACRCloud REST API (HMAC-SHA1 auth)      |
| Frontend   | HTML · Vanilla JS (no build step)       |

---

## Project Structure

```
VOD-Profiler/
├── api/
│   ├── index.js          # Local dev Express server
│   ├── upload.js         # Chunked upload + ACRCloud scan endpoint
│   └── recognize.js      # Single-shot audio recognition endpoint
├── src/
│   └── services/
│       ├── acrcloud.js   # ACRCloud API client (auth + HTTP)
│       └── parser.js     # ACRCloud response → flagged-segment mapper
├── public/
│   ├── index.html        # Frontend UI
│   └── app.js            # Chunked upload logic + results rendering
├── tests/
│   ├── acrcloud.test.js  # Signature-generation unit tests
│   └── parser.test.js    # Response-parsing unit tests
├── .env.example          # Environment variable template
├── vercel.json           # Vercel deployment configuration
└── package.json
```

---

## Quick Start (local development)

### 1. Clone & install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your ACRCloud credentials:

```env
ACRCLOUD_HOST=identify-eu-west-1.acrcloud.com
ACRCLOUD_ACCESS_KEY=your_access_key
ACRCLOUD_ACCESS_SECRET=your_access_secret
```

Sign up at [acrcloud.com](https://www.acrcloud.com/) to obtain credentials.

### 3. Start the development server

```bash
npm run dev   # uses nodemon for auto-reload
# or
npm start
```

Open http://localhost:3000 in your browser.

---

## Deployment (Vercel)

1. Push the repository to GitHub.
2. Import the project in the [Vercel dashboard](https://vercel.com/new).
3. Add the environment variables (`ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`,
   `ACRCLOUD_ACCESS_SECRET`) in the Vercel project settings.
4. Deploy – `vercel.json` configures the serverless function routes and
   memory/timeout limits automatically.

---

## API Reference

### `POST /api/upload`

Accepts one chunk of a large file upload.

| Field           | Type   | Description                                  |
|-----------------|--------|----------------------------------------------|
| `chunk`         | file   | Binary chunk data (multipart/form-data)      |
| `uploadId`      | string | Unique session ID for this upload            |
| `chunkIndex`    | number | 0-based index of this chunk                  |
| `totalChunks`   | number | Total chunks in the upload                   |
| `filename`      | string | Original filename (required on first chunk)  |
| `totalDuration` | number | *(optional)* Media duration in seconds       |

**Response** (intermediate): `{ received: true, chunkIndex, uploadId, progress }`

**Response** (final chunk): `{ done: true, uploadId, results: [...] }`

Each `result` object:

```json
{
  "trackTitle": "Blinding Lights",
  "artist": "The Weeknd",
  "album": "After Hours",
  "timestampStart": "00:14:32",
  "timestampEnd": "00:17:45",
  "timestampStartSec": 872,
  "timestampEndSec": 1065,
  "confidenceScore": 92,
  "dmcaRisk": "HIGH",
  "acrid": "abc123xyz"
}
```

DMCA Risk levels: `HIGH` (≥ 80%), `MEDIUM` (50–79%), `LOW` (< 50%).

### `POST /api/recognize`

Single-shot recognition for a small audio clip (≤ 4 MB).

| Field      | Type   | Description                                    |
|------------|--------|------------------------------------------------|
| `audio`    | file   | Audio file (mp3, wav, aac, …)                 |
| `startSec` | number | *(optional)* Time offset for timestamps (s)   |

**Response**: `{ results: [...] }`

---

## Running Tests

```bash
npm test
```

Tests cover the ACRCloud signature builder and the response parser.

---

## Architecture Notes

### Chunked Upload Strategy

Vercel serverless functions have a **4.5 MB request payload limit**.  The
frontend splits files into **4 MB chunks** (`CHUNK_SIZE = 4 * 1024 * 1024`)
and POSTs each chunk independently.  The server stores chunks in `/tmp`
(available on Vercel lambdas) and assembles them once all chunks have arrived.

### ACRCloud Authentication

The API uses HMAC-SHA1 signed requests.  The signature string is:

```
POST\n/v1/identify\n<access_key>\naudio\n1\n<unix_timestamp>
```

The signature is computed with `crypto.createHmac('sha1', accessSecret)` and
Base64-encoded.

### DMCA Risk Levels

| Level    | ACRCloud Confidence |
|----------|---------------------|
| HIGH     | ≥ 80%               |
| MEDIUM   | 50 – 79%            |
| LOW      | < 50%               |
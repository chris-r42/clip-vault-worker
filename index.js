const express = require('express')
const multer = require('multer')
const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const os = require('os')

const app = express()
const PORT = process.env.PORT || 3001

const {
  WORKER_SECRET,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_STREAM_API_TOKEN,
} = process.env


const THRESHOLD_MB = 150
const TARGET_MB = 140

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB
})

// Allow requests from any origin (clip-vault frontend)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

function getduration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) reject(err)
      else resolve(meta.format.duration)
    })
  })
}

function compress(inputPath, outputPath, videoKbps) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .videoBitrate(videoKbps)
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions(['-preset ultrafast', '-movflags +faststart', '-threads 1'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

async function uploadToCloudflare(filePath, mimeType) {
  // Get a one-time upload URL from Cloudflare
  const initRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream/direct_upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_STREAM_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        maxDurationSeconds: 3600,
        requireSignedURLs: false,
        downloadable: true,
      }),
    }
  )

  if (!initRes.ok) throw new Error(`Cloudflare init failed: ${initRes.status}`)
  const { result } = await initRes.json()
  const { uploadURL, uid } = result

  // Upload file to that URL
  const fileData = fs.readFileSync(filePath)
  const blob = new Blob([fileData], { type: mimeType ?? 'video/mp4' })
  const formData = new FormData()
  formData.append('file', blob, 'video.mp4')

  const uploadRes = await fetch(uploadURL, { method: 'POST', body: formData })
  if (!uploadRes.ok) throw new Error(`Cloudflare upload failed: ${uploadRes.status}`)

  return uid
}

app.post('/upload', upload.single('file'), async (req, res) => {
  const inputPath = req.file?.path
  let outputPath = null

  try {
    if (!WORKER_SECRET || req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const fileSizeMB = req.file.size / 1024 / 1024
    let uploadPath = inputPath
    let mimeType = req.file.mimetype

    if (fileSizeMB > THRESHOLD_MB) {
      console.log(`Compressing ${fileSizeMB.toFixed(1)} MB file...`)
      const duration = await getduration(inputPath)
      const targetBits = TARGET_MB * 8 * 1024 * 1024
      const videoKbps = Math.min(8000, Math.floor((targetBits / duration - 128 * 1024) / 1024))

      outputPath = inputPath + '_out.mp4'
      await compress(inputPath, outputPath, videoKbps)
      uploadPath = outputPath
      mimeType = 'video/mp4'
      console.log(`Compression done. Uploading to Cloudflare...`)
    }

    const videoId = await uploadToCloudflare(uploadPath, mimeType)
    console.log(`Uploaded: ${videoId}`)
    res.json({ videoId })
  } catch (err) {
    console.error('Worker error:', err)
    res.status(500).json({ error: err.message ?? 'Upload failed' })
  } finally {
    if (inputPath) fs.unlink(inputPath, () => {})
    if (outputPath) fs.unlink(outputPath, () => {})
  }
})

app.listen(PORT, () => console.log(`clip-vault-worker listening on port ${PORT}`))

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

/**
 * Build the HMAC-SHA1 signature required by the ACRCloud REST API.
 *
 * Signature string format:
 *   HTTP_METHOD\nENDPOINT\nACCESS_KEY\nDATA_TYPE\nSIGNATURE_VERSION\nTIMESTAMP
 *
 * @param {string} accessSecret - ACRCloud access secret
 * @param {string} method       - HTTP method (e.g. 'POST')
 * @param {string} endpoint     - API endpoint path (e.g. '/v1/identify')
 * @param {string} accessKey    - ACRCloud access key
 * @param {number} timestamp    - Unix timestamp in seconds
 * @returns {string} Base64-encoded HMAC-SHA1 signature
 */
function buildSignature(accessSecret, method, endpoint, accessKey, timestamp) {
  const dataType = 'audio';
  const signatureVersion = '1';
  const stringToSign = [method, endpoint, accessKey, dataType, signatureVersion, timestamp].join('\n');
  return crypto.createHmac('sha1', accessSecret).update(stringToSign).digest('base64');
}

/**
 * Submit an audio buffer to ACRCloud for fingerprint recognition.
 *
 * @param {Buffer} audioBuffer - Raw audio data (any common format: mp3, wav, aac, etc.)
 * @param {string} filename    - Filename including extension, used as MIME hint
 * @param {object} [options]   - Optional overrides
 * @param {string} [options.host]         - ACRCloud host (overrides env var)
 * @param {string} [options.accessKey]    - ACRCloud access key (overrides env var)
 * @param {string} [options.accessSecret] - ACRCloud access secret (overrides env var)
 * @param {string} [options.endpoint]     - API endpoint path (overrides env var)
 * @returns {Promise<object>} Raw ACRCloud JSON response
 * @throws {Error} On network failure or non-2xx HTTP response
 */
async function recognizeAudio(audioBuffer, filename = 'sample.mp3', options = {}) {
  const host = options.host || process.env.ACRCLOUD_HOST;
  const accessKey = options.accessKey || process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = options.accessSecret || process.env.ACRCLOUD_ACCESS_SECRET;
  const endpoint = options.endpoint || process.env.ACRCLOUD_ENDPOINT || '/v1/identify';

  if (!host || !accessKey || !accessSecret) {
    throw new Error('ACRCloud credentials are not configured. Set ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, and ACRCLOUD_ACCESS_SECRET.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildSignature(accessSecret, 'POST', endpoint, accessKey, timestamp);

  const form = new FormData();
  form.append('sample', audioBuffer, { filename, contentType: 'audio/mpeg' });
  form.append('access_key', accessKey);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('sample_bytes', String(audioBuffer.length));
  form.append('timestamp', String(timestamp));

  const url = `https://${host}${endpoint}`;

  try {
    const response = await axios.post(url, form, {
      headers: form.getHeaders(),
      timeout: 25000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      const msg = `ACRCloud API error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
      throw new Error(msg);
    }
    if (error.code === 'ECONNABORTED') {
      throw new Error('ACRCloud request timed out. The audio sample may be too large or the network is slow.');
    }
    throw new Error(`ACRCloud network error: ${error.message}`);
  }
}

module.exports = { recognizeAudio, buildSignature };

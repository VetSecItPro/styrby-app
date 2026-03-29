import type { Metadata } from "next";
import { PrevNext } from "../prev-next";
import { getPrevNext } from "../nav";

export const metadata: Metadata = {
  title: "Voice Input",
  description:
    "Send voice commands to your AI coding agents from the Styrby mobile app. Power tier, mobile only. Requires a transcription endpoint you provide.",
};

/**
 * Voice Input documentation page.
 *
 * Covers setup for OpenAI Whisper and self-hosted alternatives,
 * hold-to-talk vs toggle mode, and troubleshooting.
 * Power tier feature, mobile only.
 */
export default function VoiceDocsPage() {
  const { prev, next } = getPrevNext("/docs/voice");

  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
        Voice Input
      </h1>
      <p className="mt-3 text-zinc-400">
        Speak to your AI coding agent instead of typing. Styrby captures audio
        on the mobile app, sends it to a transcription service you configure,
        then delivers the transcribed text to your agent as a normal message.
        Power tier feature. Mobile only.
      </p>
      <p className="mt-3 text-zinc-400">
        Styrby does not include a transcription service and never processes or
        stores your audio. Audio goes directly from your phone to whichever
        transcription endpoint you configure. Your code conversations stay
        private.
      </p>

      {/* Overview */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">Overview</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm text-left text-zinc-400">
          <thead className="text-xs uppercase text-zinc-500 border-b border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Property</th>
              <th className="py-2">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Tier requirement</td>
              <td className="py-2">Power tier</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Platform</td>
              <td className="py-2">iOS and Android (mobile only)</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Audio storage</td>
              <td className="py-2">Never stored by Styrby</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Audio routing</td>
              <td className="py-2">Phone to your transcription endpoint directly</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Transcription service</td>
              <td className="py-2">Provided by you (not included in Styrby)</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Requirements */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Requirements
      </h2>
      <p className="mt-3 text-zinc-400">
        To use Voice Input you need two things:
      </p>
      <ul className="mt-3 list-disc list-inside space-y-2 text-zinc-400">
        <li>
          <strong className="text-zinc-300">A transcription endpoint</strong>{" "}
          that accepts audio and returns text. The endpoint must accept{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            multipart/form-data
          </code>{" "}
          POST requests with a{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            file
          </code>{" "}
          field and return a text response. The OpenAI Whisper API format is
          the default.
        </li>
        <li>
          <strong className="text-zinc-300">An API key or access token</strong>{" "}
          for that service, if required.
        </li>
      </ul>
      <p className="mt-3 text-zinc-400">
        The recommended service is the{" "}
        <strong className="text-zinc-300">OpenAI Whisper API</strong> at
        $0.006 per minute. A two-minute voice command costs less than two cents.
        Self-hosted alternatives are also supported for teams with stricter
        privacy requirements.
      </p>

      {/* OpenAI Whisper setup */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Setting Up with OpenAI Whisper
      </h2>
      <p className="mt-3 text-zinc-400">
        OpenAI&apos;s Whisper API is the easiest way to get started. It requires
        an OpenAI account and a few minutes of setup.
      </p>
      <ol className="mt-3 list-decimal list-inside space-y-2 text-zinc-400">
        <li>
          Sign in at{" "}
          <strong className="text-zinc-300">platform.openai.com</strong>
        </li>
        <li>
          Go to{" "}
          <strong className="text-zinc-300">
            API Keys
          </strong>{" "}
          in the left sidebar
        </li>
        <li>
          Click <strong className="text-zinc-300">Create new secret key</strong>,
          name it &quot;Styrby Voice&quot;, and copy the key
        </li>
        <li>
          Open the Styrby mobile app and go to{" "}
          <strong className="text-zinc-300">Settings &gt; Voice Input</strong>
        </li>
        <li>
          Set <strong className="text-zinc-300">Transcription Endpoint</strong>{" "}
          to:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-sm text-zinc-300 border border-zinc-800">
{`https://api.openai.com/v1/audio/transcriptions`}
          </pre>
        </li>
        <li>
          Set <strong className="text-zinc-300">API Key</strong> to the key you
          copied in step 3
        </li>
        <li>
          Set <strong className="text-zinc-300">Model</strong> to{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            whisper-1
          </code>
        </li>
        <li>
          Tap <strong className="text-zinc-300">Save</strong> and then{" "}
          <strong className="text-zinc-300">Test Microphone</strong> to confirm
          transcription works
        </li>
      </ol>
      <p className="mt-3 text-zinc-500 text-sm">
        The API key is stored securely in your device keychain. It is never sent
        to Styrby servers.
      </p>

      {/* Self-hosted */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Self-Hosted Transcription
      </h2>
      <p className="mt-3 text-zinc-400">
        If you prefer not to send audio to a third-party cloud service, you can
        run a local Whisper server. Two popular options:
      </p>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Whisper.cpp (fastest on Apple Silicon)
      </h3>
      <p className="mt-2 text-sm text-zinc-400">
        Whisper.cpp is a C++ port of OpenAI Whisper that runs a local HTTP
        server. It is the fastest self-hosted option on Apple Silicon Macs.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Clone and build
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
make

# Download a model (base is fast and accurate enough for voice commands)
bash ./models/download-ggml-model.sh base.en

# Start the server on port 8080
./server -m models/ggml-base.en.bin --port 8080`}
      </pre>
      <p className="mt-3 text-zinc-400">
        Then in Styrby mobile Settings &gt; Voice Input, set:
      </p>
      <ul className="mt-2 space-y-1 text-zinc-400 text-sm list-disc list-inside">
        <li>
          <strong className="text-zinc-300">Transcription Endpoint:</strong>{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            http://your-mac-ip:8080/inference
          </code>
        </li>
        <li>
          <strong className="text-zinc-300">API Key:</strong> leave blank (no
          auth required for local server)
        </li>
      </ul>
      <p className="mt-2 text-zinc-500 text-sm">
        Your phone and Mac must be on the same network for a local server to be
        reachable from the mobile app.
      </p>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Faster Whisper (Docker)
      </h3>
      <p className="mt-2 text-sm text-zinc-400">
        Faster Whisper uses CTranslate2 for significantly faster inference than
        the original Whisper model, and is easy to run with Docker.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300 border border-zinc-800">
{`# Run Faster Whisper with the whisper-asr-webservice image
docker run -d -p 9000:9000 \
  -e ASR_MODEL=base \
  onerahmet/openai-whisper-asr-webservice:latest`}
      </pre>
      <p className="mt-3 text-zinc-400">
        In Styrby mobile Settings &gt; Voice Input, set the endpoint to:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-sm text-zinc-300 border border-zinc-800">
{`http://your-server-ip:9000/asr`}
      </pre>

      {/* Configuration options */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Configuration Options
      </h2>
      <p className="mt-3 text-zinc-400">
        All voice settings are under{" "}
        <strong className="text-zinc-300">Settings &gt; Voice Input</strong> in
        the Styrby mobile app.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm text-left text-zinc-400">
          <thead className="text-xs uppercase text-zinc-500 border-b border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Setting</th>
              <th className="py-2 pr-4">Options</th>
              <th className="py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Input mode</td>
              <td className="py-2 pr-4">Hold to talk / Toggle</td>
              <td className="py-2 text-xs">
                Hold to talk: press and hold the mic button while speaking, release to
                transcribe. Toggle: tap once to start, tap again to stop.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Transcription endpoint</td>
              <td className="py-2 pr-4">URL string</td>
              <td className="py-2 text-xs">
                Must accept{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">
                  multipart/form-data
                </code>{" "}
                with a{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">
                  file
                </code>{" "}
                field and return a text response.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">API key</td>
              <td className="py-2 pr-4">String</td>
              <td className="py-2 text-xs">
                Sent as{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">
                  Authorization: Bearer &lt;key&gt;
                </code>
                . Leave blank for unauthenticated local servers.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Model</td>
              <td className="py-2 pr-4">String</td>
              <td className="py-2 text-xs">
                Passed as the{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">
                  model
                </code>{" "}
                field in the form data. Use{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">
                  whisper-1
                </code>{" "}
                for the OpenAI API.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Language</td>
              <td className="py-2 pr-4">Auto / ISO 639-1 code</td>
              <td className="py-2 text-xs">
                Auto-detect is recommended. Set a specific language code (e.g.,{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">
                  en
                </code>
                ) to improve accuracy for short technical phrases.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-zinc-300">Request timeout</td>
              <td className="py-2 pr-4">5 to 30 seconds</td>
              <td className="py-2 text-xs">
                Increase if transcription requests fail on slow connections or
                for longer recordings.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Troubleshooting */}
      <h2 className="mt-10 text-xl font-semibold text-zinc-100">
        Troubleshooting
      </h2>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        No transcription returned
      </h3>
      <ul className="mt-2 list-disc list-inside space-y-2 text-zinc-400">
        <li>
          Confirm the endpoint URL is correct and reachable from your phone.
          Open a browser on the same network and navigate to the URL to check
          connectivity.
        </li>
        <li>
          Check that the API key is valid. For OpenAI, verify the key has not
          been revoked in the API Keys dashboard.
        </li>
        <li>
          Confirm microphone permission is granted to the Styrby app in your
          phone&apos;s system settings (Settings &gt; Styrby &gt; Microphone).
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Garbled or inaccurate transcription
      </h3>
      <ul className="mt-2 list-disc list-inside space-y-2 text-zinc-400">
        <li>
          Speak clearly and at a moderate pace. Background noise significantly
          reduces accuracy.
        </li>
        <li>
          Set a specific language code in Settings &gt; Voice Input &gt;
          Language instead of using auto-detect. Technical jargon like variable
          names and framework names transcribes more accurately with a known
          language hint.
        </li>
        <li>
          If using a self-hosted model, try a larger model variant (e.g.,{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            small
          </code>{" "}
          or{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            medium
          </code>{" "}
          instead of{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            base
          </code>
          ).
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Request timeout
      </h3>
      <ul className="mt-2 list-disc list-inside space-y-2 text-zinc-400">
        <li>
          Increase the timeout in Settings &gt; Voice Input &gt; Request
          Timeout. A 10-second timeout is usually enough for cloud services.
          Self-hosted servers on first load may need up to 20 seconds while the
          model warms up.
        </li>
        <li>
          For self-hosted servers, confirm the server is running and not
          sleeping. Containers on low-memory hosts sometimes get killed under
          load.
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-medium text-zinc-200">
        Voice Input option not available
      </h3>
      <p className="mt-2 text-sm text-zinc-400">
        Voice Input requires the Power tier. If the setting is grayed out,
        upgrade your plan from{" "}
        <strong className="text-zinc-300">Settings &gt; Plan</strong> in the
        mobile app or from the{" "}
        <strong className="text-zinc-300">Pricing</strong> page on the web
        dashboard.
      </p>

      <PrevNext prev={prev} next={next} />
    </article>
  );
}

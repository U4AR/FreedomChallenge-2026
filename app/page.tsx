export default function Home() {
  const realtimeUrl = process.env.REALTIME_SERVER_URL || "";
  return <main id="app" data-realtime-url={realtimeUrl} data-view="player">
    <noscript>This live quiz requires JavaScript.</noscript>
    <script src="/quiz-app.js" defer></script>
  </main>;
}

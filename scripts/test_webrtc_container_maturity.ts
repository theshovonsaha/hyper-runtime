import { WebRtcAudioEngine, ContainerSandboxRunner } from '../src/modules';

async function testWebrtcContainerMaturity() {
  console.log('========================================================================');
  console.log('--- WEBRTC AUDIO & CONTAINER MICRO-VM MATURITY VERIFICATION SUITE ---');
  console.log('========================================================================');

  // 1. Test WebRTC Real-Time Duplex Audio Streaming Engine
  console.log('\n[Part 1] Testing WebRTC Real-Time Duplex Audio Streaming Engine...');
  const audio = new WebRtcAudioEngine();
  audio.startDuplexStream();

  const pcm = new Float32Array([0.05, 0.1, -0.05, 0.08, 0.12]);
  const frame = audio.pushAudioFrame(pcm, 16000);
  const isSpeech = audio.detectVoiceActivity(frame, 0.01);

  console.log(`  Pushed Audio Frame ID: ${frame.frameId} (Sample Rate: ${frame.sampleRate} Hz)`);
  console.log(`  Voice Activity Detected (VAD): ${isSpeech}`);

  // 2. Test Containerized Micro-VM Sandbox Runner
  console.log('\n[Part 2] Testing Containerized Micro-VM Sandbox Runner...');
  const runner = new ContainerSandboxRunner({ maxMemoryMb: 256, timeoutMs: 3000 });
  const execRes = await runner.runSandboxedCode('console.log("Containerized execution output: Mach 5 Verified");');

  console.log('  Container Execution ID:', execRes.executionId);
  console.log('  Stdout:', execRes.stdout);
  console.log('  Exit Code:', execRes.exitCode);

  if (isSpeech && execRes.success && execRes.stdout.includes('Mach 5 Verified')) {
    console.log('\n========================================================================');
    console.log('--- ALL WEBRTC AUDIO & CONTAINER SANDBOX TESTS PASSED (100% MATURE) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: WebRTC and container maturity tests failed.');
  }
}

testWebrtcContainerMaturity().catch(console.error);

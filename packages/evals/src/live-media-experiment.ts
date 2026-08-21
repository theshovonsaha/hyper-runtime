import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DeepgramSpeechSynthesisCapability,
  ElevenLabsSpeechSynthesisCapability,
  OpenAiCompatibleVisionCapability,
  OpenAiImageGenerationCapability,
} from '@hyper/capabilities';
import { CONTRACT_VERSION, type ActionProposal, type CapabilityAdapter, type IntentContract } from '@hyper/contracts';
import { AuthorizedRuntime } from '@hyper/runtime';

export interface LiveMediaTrial {
  provider: string;
  capabilityId: string;
  model: string;
  status: string;
  latencyMs: number;
  verified: boolean;
  error?: string;
}
export interface LiveMediaReport {
  evidenceClass: 'live_provider_media';
  generatedAt: string;
  trials: LiveMediaTrial[];
  configuredProviders: string[];
  passRate: number;
}

async function trial(input: {
  provider: string;
  model: string;
  capability: CapabilityAdapter<any>;
  target: string;
  args: Record<string, unknown>;
}): Promise<LiveMediaTrial> {
  const started = Date.now();
  const proposal: ActionProposal = {
    id: `proposal:live-media:${input.provider}:${crypto.randomUUID()}`,
    intentId: `intent:live-media:${input.provider}`,
    principalId: 'agent:live-media-eval',
    conditionIds: [], capabilityId: input.capability.manifest.id, target: input.target,
    declaredEffects: [...(input.capability.manifest.requiredEffects ?? input.capability.manifest.effects)],
    risk: input.capability.manifest.riskCeiling, expectedEvidence: [],
    idempotencyKey: `effect:live-media:${crypto.randomUUID()}`, args: input.args,
  };
  const intent: IntentContract = {
    id: proposal.intentId, version: CONTRACT_VERSION, objective: `Evaluate ${input.capability.manifest.id}.`,
    principals: [proposal.principalId], authorizedCapabilities: [proposal.capabilityId], authorizedResources: [proposal.target],
    prohibitedEffects: ['state.delete','process.execute'], requiredConditionIds: [], requiredEvidence: [],
    riskBudget: 5, approvalAboveRisk: 5, completionCriteria: ['Provider result is observed by the capability verifier.'],
  };
  const now = new Date();
  try {
    const outcome = await new AuthorizedRuntime().execute({
      runId: `run:live-media:${crypto.randomUUID()}`, now: now.toISOString(), intent, conditions: [], proposal,
      capability: input.capability,
      approval: { id:`approval:${crypto.randomUUID()}`,proposalId:proposal.id,principalId:proposal.principalId,
        issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+300_000).toISOString() },
    });
    return { provider:input.provider,capabilityId:proposal.capabilityId,model:input.model,status:outcome.status,
      latencyMs:Date.now()-started,verified:outcome.verification?.passed===true };
  } catch (error) {
    return { provider:input.provider,capabilityId:proposal.capabilityId,model:input.model,status:'error',
      latencyMs:Date.now()-started,verified:false,error:error instanceof Error?error.message:String(error) };
  }
}

export async function runLiveMediaExperiment(environment = process.env): Promise<LiveMediaReport> {
  const root = process.cwd();
  mkdirSync(resolve(root,'evals/live-artifacts'),{recursive:true});
  const tasks: Array<Promise<LiveMediaTrial>> = [];
  if (environment.DEEPGRAM_API_KEY) {
    const model=environment.HYPER_DEEPGRAM_TTS_MODEL??'aura-2-thalia-en';
    tasks.push(trial({provider:'deepgram',model,capability:new DeepgramSpeechSynthesisCapability(root,{apiKey:environment.DEEPGRAM_API_KEY,model}),target:'workspace/evals/live-artifacts/deepgram.mp3',args:{text:'Hyper Runtime live media verification.'}}));
  }
  if (environment.ELEVENLABS_API_KEY && environment.ELEVENLABS_VOICE_ID) {
    const model=environment.HYPER_ELEVENLABS_TTS_MODEL??'eleven_flash_v2_5';
    tasks.push(trial({provider:'elevenlabs',model,capability:new ElevenLabsSpeechSynthesisCapability(root,{apiKey:environment.ELEVENLABS_API_KEY,model,voiceId:environment.ELEVENLABS_VOICE_ID}),target:'workspace/evals/live-artifacts/elevenlabs.mp3',args:{text:'Hyper Runtime live media verification.'}}));
  }
  if (environment.OPENAI_API_KEY) {
    const visionModel=environment.HYPER_VISION_MODEL??'gpt-4.1-mini';
    tasks.push(trial({provider:'openai-vision',model:visionModel,capability:new OpenAiCompatibleVisionCapability(root,{apiKey:environment.OPENAI_API_KEY,model:visionModel}),target:'workspace/ui/morph-ui/shovs-frontend/src/assets/hero.png',args:{prompt:'Describe the visible interface image in one sentence.'}}));
    const imageModel=environment.HYPER_IMAGE_MODEL??'gpt-image-1';
    tasks.push(trial({provider:'openai-image',model:imageModel,capability:new OpenAiImageGenerationCapability(root,{apiKey:environment.OPENAI_API_KEY,model:imageModel}),target:'workspace/evals/live-artifacts/generated.png',args:{prompt:'A small abstract cyan and violet verification mark on a dark background.'}}));
  }
  if (tasks.length===0) throw new Error('No live media credentials are configured.');
  const trials=await Promise.all(tasks);
  return {evidenceClass:'live_provider_media',generatedAt:new Date().toISOString(),trials,
    configuredProviders:[...new Set(trials.map(item=>item.provider))],passRate:trials.filter(item=>item.verified).length/trials.length};
}

if(import.meta.main){const report=await runLiveMediaExperiment();const output=resolve(process.cwd(),'evals/results/live-media-latest.json');writeFileSync(output,`${JSON.stringify(report,null,2)}\n`);console.log(`Live Media Evals: pass_rate=${report.passRate.toFixed(3)} providers=${report.configuredProviders.join(',')}`);if(report.passRate<1)process.exitCode=1;}

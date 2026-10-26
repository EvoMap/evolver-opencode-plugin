// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { fileURLToPath } from 'node:url';

import { evolveCommand, evolvePromptOf } from './commands.js';
import { configOf } from './config.js';
import { createRecallLog, createReportLog, recallSettingsOf } from './diagnostics.js';
import { createDistiller } from './distiller.js';
import { prepareEngine, setupNoticeText } from './engine-setup.js';
import { installedEvolverVersion } from './engine-version.js';
import { feedbackLabelOf } from './feedback-label.js';
import { helperCompletion, serverSessions } from './helper-session.js';
import { forgetSession, takeOrphanedUnreported, takeUnreported } from './injected-assets.js';
import { recordReuseLocally } from './local-ledger.js';
import { noticeDue, pendingClaimUrl } from './onboarding.js';
import { promptTextOf } from './prime.js';
import { projectDirOf } from './project-dir.js';
import { createProxyClient } from './proxy.js';
import { createRecall } from './recall.js';
import { createReportQueue, enqueueReports } from './report-queue.js';
import { rememberForRetention, retentionReportsOf, takeDueRetentions } from './retention-pending.js';
import { correctionReportOf, immediateReportOf, reportedReuseOf } from './reuse.js';
import { candidateOf, closeCandidate, modelOf, rememberCandidate, skipReason } from './session-distill.js';
import { PERSON, createSessionKinds, kindOfSession } from './session-kinds.js';
import { nextTurn } from './turn-counter.js';
import { createTurnRecords, noteAnswer, noteFileBeforeEdit, noteToolResult } from './turn-record.js';
import { outcomeOfReason } from './turn-outcomes.js';
import { createOpenTurns } from './turn-state.js';

const SKILLS_DIR = fileURLToPath(new URL('../assets/skills/', import.meta.url));
const NOTICE_MS = 15_000;

function reportsOf(assets, { sessionId, turn, reasonKind, record }) {
  return assets.map((asset) => immediateReportOf({
    asset,
    sessionId,
    turn: turn ?? asset.turn,
    reasonKind,
    checks: record.checks,
  }));
}

function abortedReports(assets) {
  return assets.map((asset) => ({
    report: reportsOf([asset], { sessionId: asset.sessionId, reasonKind: 'aborted', record: { checks: [] } })[0],
    sessionId: asset.sessionId,
  }));
}

// A notice is for the person, so it is a toast rather than a message: nothing of it reaches the model.
function toaster(client) {
  return (message) => client.tui.showToast({ body: { message, variant: 'info', duration: NOTICE_MS } }).catch(() => {});
}

// Installing or upgrading Evolver takes up to minutes, so it runs once per OpenCode instance in the background.
function createEngineSetup(prepare, notify) {
  let started = null;
  return {
    start() {
      started ??= prepare()
        .then((outcome) => {
          const text = setupNoticeText(outcome);
          if (text) notify(text);
        })
        .catch(() => {});
    },
  };
}

function claimNudge(config, notify) {
  const claimUrl = config.claimNudgeEnabled ? pendingClaimUrl() : null;
  if (!claimUrl || !noticeDue(claimUrl, config.claimNudgeTtlMs)) return;
  notify(`[Evolver] Your local node is not connected to the EvoMap network yet. Open ${claimUrl} `
    + 'while signed in to evomap.ai. Local memory already works; claiming enables network reuse.');
}

function registerEvolveCommand(cfg) {
  const { name, description, template } = evolveCommand();
  cfg.command = { [name]: { description, template }, ...cfg.command };
}

function offerSkill(cfg) {
  cfg.skills = { ...cfg.skills, paths: [...(cfg.skills?.paths ?? []), SKILLS_DIR] };
}

// The next prompt is the only verdict on a turn available without asking anyone: when it reads as a
// correction, the reuse reports are revised and the turn is no longer worth distilling.
function followUpReporter(deliver, labelable, prompts, distiller) {
  return (sessionId, prompt) => {
    if (!prompt) return;
    const label = feedbackLabelOf(prompt);
    if (label === 'correction') distiller.forget(sessionId);
    prompts.set(sessionId, prompt);
    if (!labelable.has(sessionId)) return;
    const reuses = labelable.get(sessionId);
    labelable.delete(sessionId);
    const reports = reuses.map((reuse) => correctionReportOf(reuse, label)).filter((report) => report !== null);
    deliver(reports.map((report) => ({ report, sessionId }))).catch(() => {});
  };
}

function withEvolvePrompt(parts, rawInput) {
  const text = parts.find((part) => part?.type === 'text');
  if (text) text.text = evolvePromptOf(evolveCommand().template, rawInput);
}

/**
 * Nothing of Evolver but the recalled steps enters the model's context: no tools, and the skill only when
 * configured. People reach it through the TUI's /evolver-* commands, which run in the plugin; reports and
 * distillation run on session events.
 */
async function EvolverServer(input, options) {
  const config = configOf(options);
  const projectDir = projectDirOf(input.directory);
  const notify = toaster(input.client);
  const proxyFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.proxyTimeoutMs });
  const primeFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.assetPrimeTimeoutMs });
  const engineSetup = createEngineSetup(() => prepareEngine({
    probeVersion: installedEvolverVersion,
    isProxyReachable: async () => !(await proxyFetch('GET', '/proxy/status')).unreachable,
  }), notify);
  const reportLog = createReportLog();
  const deliver = createReportQueue({ proxyFetch, recordLocally: recordReuseLocally, onSettled: reportLog.record });
  const distiller = createDistiller({ proxyFetch, complete: helperCompletion(serverSessions(input.client)) });
  const kinds = createSessionKinds(async (id) => (await input.client.session.get({ path: { id } }))?.data);
  const turns = createOpenTurns();
  const records = createTurnRecords();
  const recall = createRecall({
    config,
    primeFetch,
    recallLog: createRecallLog(recallSettingsOf(config)),
    isTurnOpen: (sessionId, turn) => turns.get(sessionId)?.turn === turn,
  });
  const labelable = new Map();
  const prompts = new Map();
  const started = new Set();
  const deleted = new Set();
  const evolving = new Set();
  const onPrompt = followUpReporter(deliver, labelable, prompts, distiller);

  // Every injected strategy is reported when its turn ends, with the turn's own evidence; the turn itself
  // becomes this session's distillation candidate when it finished verified without reusing one.
  const closeTurn = (sessionId) => {
    const ended = turns.close(sessionId);
    if (!ended) return;
    const { turn, reasonKind, lastAssistant } = ended;
    const finished = records.take(sessionId);
    if (!outcomeOfReason(reasonKind)) return;
    const reports = reportsOf(takeUnreported(sessionId, turn), { sessionId, turn, reasonKind, record: finished });
    const reuses = reports.map(reportedReuseOf);
    labelable.set(sessionId, reuses);
    deliver(reports.map((report) => ({ report, sessionId }))).catch(() => {});
    rememberForRetention({ sessionId, projectDir, reuses, editedBefore: finished.editedBefore });
    if (skipReason(reasonKind, finished)) return;
    rememberCandidate(sessionId, candidateOf({ prompt: prompts.get(sessionId), record: finished, model: modelOf(lastAssistant), turn }));
  };

  // OpenCode has no session-start hook: a session starts, for this process, with its first prompt here.
  const startSession = (sessionId) => {
    engineSetup.start();
    if (started.has(sessionId)) return;
    started.add(sessionId);
    claimNudge(config, notify);
    const due = takeDueRetentions({ sessionId, projectDir });
    deliver([...due.flatMap(retentionReportsOf), ...abortedReports(takeOrphanedUnreported())]).catch(() => {});
    distiller.distillLeftovers();
  };

  // A session ends when it is deleted or when OpenCode shuts down, which may not wait for the network: its
  // aborted reports only enter the outbox and its candidate is closed, for the next delivery and session start.
  const endSession = (sessionId) => {
    enqueueReports(abortedReports(takeUnreported(sessionId, Infinity)));
    closeCandidate(sessionId);
    turns.close(sessionId);
    records.forget(sessionId);
    recall.forget(sessionId);
    labelable.delete(sessionId);
    prompts.delete(sessionId);
    forgetSession(sessionId);
    started.delete(sessionId);
  };

  const onEvent = {
    'session.created': ({ info }) => kinds.note(info),
    'session.status': ({ sessionID, status }) => turns.noteStatus(sessionID, status),
    'message.updated': ({ info }) => {
      if (info?.role === 'assistant') turns.noteAssistant(info.sessionID, info);
    },
    'session.error': ({ sessionID, error }) => turns.noteError(sessionID, error),
    'session.idle': ({ sessionID }) => closeTurn(sessionID),
    'session.deleted': ({ sessionID, info }) => {
      if (kindOfSession(info) !== PERSON) return;
      deleted.add(sessionID);
      endSession(sessionID);
      deliver().catch(() => {});
      distiller.distillSession(sessionID).catch(() => {});
    },
  };

  return {
    config: async (cfg) => {
      registerEvolveCommand(cfg);
      if (config.skillEnabled) offerSkill(cfg);
    },

    'command.execute.before': async ({ command, sessionID, arguments: rawInput }, output) => {
      if (command !== evolveCommand().name) return;
      evolving.add(sessionID);
      withEvolvePrompt(output.parts, rawInput);
    },

    // A prompt sent while its session is busy joins the running turn and starts none.
    'chat.message': async ({ sessionID }, output) => {
      const isEvolve = evolving.delete(sessionID);
      if ((await kinds.of(sessionID)) !== PERSON || deleted.has(sessionID)) return;
      if (turns.has(sessionID)) {
        if (turns.isBusy(sessionID)) return;
        closeTurn(sessionID);
      }
      startSession(sessionID);
      const turn = nextTurn(sessionID);
      turns.open(sessionID, turn);
      const text = isEvolve ? '' : promptTextOf(output.parts);
      onPrompt(sessionID, text);
      const part = await recall.forPrompt({ sessionId: sessionID, messageId: output.message.id, turn, text });
      if (part) output.parts.push(part);
    },

    'experimental.chat.messages.transform': async (_input, output) => recall.joinLate(output.messages),

    'tool.execute.before': async ({ tool, sessionID }, output) => {
      if (turns.has(sessionID) && config.editToolNames.includes(tool)) noteFileBeforeEdit(records.of(sessionID), projectDir, output.args);
    },

    'tool.execute.after': async ({ tool, sessionID, args }, output) => {
      if (!turns.has(sessionID)) return;
      try {
        noteToolResult(records.of(sessionID), { name: tool, arguments: args }, output, { isEdit: config.editToolNames.includes(tool) });
      } catch {
      }
    },

    'experimental.text.complete': async ({ sessionID, messageID }, output) => {
      if (turns.has(sessionID)) noteAnswer(records.of(sessionID), messageID, output.text);
    },

    event: async ({ event }) => onEvent[event?.type]?.(event.properties ?? {}),

    dispose: async () => {
      for (const sessionId of [...started]) endSession(sessionId);
    },
  };
}

// Nothing else is exported: OpenCode's legacy loader takes every export of a module for a plugin function.
export default { id: 'evomap.evolver', server: EvolverServer };

'use strict';

/**
 * play-coach-selftest.js
 *
 * Self-test suite for Play-Coach Adaptive Sparring Partner & Real-Time Coach.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PlayCoach = require('../src/play-coach.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// 1. Session Initialization
test('createPlayCoachSession sets up default persona and initial ratings', () => {
  const session = PlayCoach.createPlayCoachSession({ initialRating: 1400, persona: 'tactical' });
  assert.strictEqual(session.targetRating, 1400);
  assert.strictEqual(session.currentStrength, 1400);
  assert.strictEqual(session.persona.id, 'tactical');
  assert.strictEqual(session.takebacksAllowed, 3);
  assert.strictEqual(session.takebacksUsed, 0);
});

// 2. Adaptive Strength Ramping
test('adaptCoachStrength ramps up difficulty on player mastery streak', () => {
  const session = PlayCoach.createPlayCoachSession({ initialRating: 1200 });

  PlayCoach.adaptCoachStrength(session, 'best');
  PlayCoach.adaptCoachStrength(session, 'best');
  const res = PlayCoach.adaptCoachStrength(session, 'best'); // 3rd consecutive best move

  assert.strictEqual(res.change, 50);
  assert.strictEqual(session.currentStrength, 1250);
  assert.ok(res.explanation.includes('Ramping up'));
});

test('adaptCoachStrength eases difficulty on consecutive player blunders', () => {
  const session = PlayCoach.createPlayCoachSession({ initialRating: 1200 });

  PlayCoach.adaptCoachStrength(session, 'blunder');
  const res = PlayCoach.adaptCoachStrength(session, 'blunder'); // 2nd consecutive blunder

  assert.strictEqual(res.change, -50);
  assert.strictEqual(session.currentStrength, 1150);
  assert.ok(res.explanation.includes('Easing opponent pressure'));
});

// 3. Proactive Threat Warnings
test('analyzeThreats detects check as immediate danger with guiding question', () => {
  const threat = PlayCoach.analyzeThreats({ isCheck: true });
  assert.strictEqual(threat.hasThreat, true);
  assert.strictEqual(threat.level, 'danger');
  assert.strictEqual(threat.threatType, 'check');
  assert.ok(threat.message.includes('King is in check'));
  assert.ok(threat.guidingQuestion.includes('block'));
});

test('analyzeThreats detects hanging pieces on targeted squares', () => {
  const threat = PlayCoach.analyzeThreats({ hangingSquares: ['c3'] });
  assert.strictEqual(threat.hasThreat, true);
  assert.strictEqual(threat.level, 'warning');
  assert.strictEqual(threat.threatType, 'hanging_piece');
  assert.ok(threat.message.includes('c3'));
  assert.ok(threat.guidingQuestion.includes('adequately protected'));
});

test('analyzeThreats reports safe state when no immediate threats exist', () => {
  const threat = PlayCoach.analyzeThreats({ isCheck: false, hangingSquares: [] });
  assert.strictEqual(threat.hasThreat, false);
  assert.strictEqual(threat.level, 'safe');
  assert.ok(threat.guidingQuestion.includes('least active'));
});

// 4. Socratic Guiding Questions
test('getSocraticQuestion delivers stage-appropriate prompts', () => {
  const qTactics = PlayCoach.getSocraticQuestion({ hasTactics: true });
  assert.ok(qTactics.includes('fork, pin, or skewer'));

  const qOpening = PlayCoach.getSocraticQuestion({ phase: 'opening' });
  assert.ok(qOpening.includes('center') && qOpening.includes('king safe'));

  const qEndgame = PlayCoach.getSocraticQuestion({ phase: 'endgame' });
  assert.ok(qEndgame.includes('King is an attacking piece'));
});

// 5. Takebacks & Retry Coaching Dialogue
test('evaluateTakebackOpportunity offers dialogue and hint on blunder', () => {
  const session = PlayCoach.createPlayCoachSession({ persona: 'encouraging' });
  const takeback = PlayCoach.evaluateTakebackOpportunity(session, 'blunder', 'Nf3');

  assert.strictEqual(takeback.offerTakeback, true);
  assert.ok(takeback.coachingDialogue.includes('Careful'));
  assert.ok(takeback.guidingHint.includes('Nf3'));
  assert.strictEqual(takeback.takebacksRemaining, 3);
});

test('recordTakeback tracks takeback quota correctly', () => {
  const session = PlayCoach.createPlayCoachSession();
  assert.strictEqual(PlayCoach.recordTakeback(session), true);
  assert.strictEqual(session.takebacksUsed, 1);
  assert.strictEqual(PlayCoach.recordTakeback(session), true);
  assert.strictEqual(session.takebacksUsed, 2);
  assert.strictEqual(PlayCoach.recordTakeback(session), true);
  assert.strictEqual(session.takebacksUsed, 3);

  // 4th takeback should be denied (limit 3)
  assert.strictEqual(PlayCoach.recordTakeback(session), false);
  const tb = PlayCoach.evaluateTakebackOpportunity(session, 'blunder');
  assert.strictEqual(tb.offerTakeback, false);
});

// 6. Gate 4 Invariant
test('Gate 4 Invariant: src/play-coach.js has 0 makeMove/createInitialBoard calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/play-coach.js'), 'utf8');
  assert.strictEqual(src.includes('makeMove('), false, 'Forbidden makeMove() call found');
  assert.strictEqual(src.includes('createInitialBoard('), false, 'Forbidden createInitialBoard() call found');
});

console.log(`\nAll ${passed} tests passed successfully!`);

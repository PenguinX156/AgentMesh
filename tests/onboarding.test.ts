import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRepoName } from '../src/onboarding.js';
import { validatePlan, defaultPlan } from '../src/config.js';

test('GitHub onboarding accepts canonical HTTPS and SSH remotes and rejects unsafe forms', () => {
  assert.equal(githubRepoName('https://github.com/example/project.git'), 'project');
  assert.equal(githubRepoName('git@github.com:example/project.git'), 'project');
  for (const remote of ['https://evil.example/example/project', 'https://github.com/example/project?x=1', 'https://github.com/example/../project', 'git@github.com:example/../project']) {
    assert.throws(() => githubRepoName(remote));
  }
});

test('agent plans reject model overrides so the harness owns model selection', () => {
  const plan = defaultPlan('library', [{ id: 'codex', harness: 'codex', role: 'developer' }]);
  assert.throws(() => validatePlan({ ...plan, agents: [{ ...plan.agents[0], model: 'hardcoded' }] }));
});

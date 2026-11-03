import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CC_FIELDS,
    TC_FIELDS,
    apiChoices,
    blankProfile,
    detectMode,
    fieldsForMode,
    isExcluded,
    modeForApi,
    profileMode,
    profileSummary,
    pruneToMode,
    setExcluded,
    setFieldValue,
    uniqueCopyName,
    uniqueName,
    validateProfileName,
} from '../../src/profile-fields.js';

const API_MAP = {
    openai: { selected: 'openai' },
    claude: { selected: 'openai' },
    custom: { selected: 'openai' },
    textgenerationwebui: { selected: 'textgenerationwebui' },
    kobold: { selected: 'kobold' },
};

test('chat profiles carry chat fields only; text profiles add templates', () => {
    assert.equal(CC_FIELDS[0], 'api');
    assert.ok(CC_FIELDS.includes('prompt-post-processing'));
    assert.ok(!CC_FIELDS.includes('sysprompt'));
    assert.ok(!CC_FIELDS.includes('instruct'));
    for (const field of ['sysprompt', 'instruct', 'context', 'tokenizer']) {
        assert.ok(TC_FIELDS.includes(field), field);
    }
    assert.deepEqual(fieldsForMode('cc'), CC_FIELDS);
    assert.deepEqual(fieldsForMode('tc'), TC_FIELDS);
    // Unknown modes must not crash and default to chat completion.
    assert.deepEqual(fieldsForMode(''), CC_FIELDS);
});

test('mode follows the live API and falls back when the profile has none', () => {
    assert.equal(detectMode('openai'), 'cc');
    assert.equal(detectMode('textgenerationwebui'), 'tc');
    assert.equal(profileMode({ mode: 'tc' }, 'openai'), 'tc');
    assert.equal(profileMode({}, 'openai'), 'cc');
    assert.equal(profileMode(null, 'kobold'), 'tc');
});

test('profile names must be non-empty, unique and not <None>', () => {
    const profiles = [{ id: 'a', name: 'Work' }, { id: 'b', name: 'Home' }];
    assert.equal(validateProfileName('', profiles), 'empty');
    assert.equal(validateProfileName('   ', profiles), 'empty');
    assert.equal(validateProfileName('<None>', profiles), 'reserved');
    assert.equal(validateProfileName('Work', profiles), 'duplicate');
    assert.equal(validateProfileName('Work', profiles, 'a'), null);
    assert.equal(validateProfileName('Other', profiles), null);
    assert.equal(validateProfileName(' Work ', profiles, 'a'), null);
});

test('duplicate names get a free suffix', () => {
    assert.equal(uniqueCopyName('Work', []), 'Work (copy)');
    assert.equal(uniqueCopyName('Work', [{ name: 'Work (copy)' }]), 'Work (copy 2)');
    assert.equal(uniqueName('Work', []), 'Work');
    assert.equal(uniqueName('Work', [{ name: 'Work' }]), 'Work 2');
    assert.equal(uniqueName('Work', [{ name: 'Work' }, { name: 'Work 2' }]), 'Work 3');
    assert.equal(uniqueCopyName('', []), 'Profile (copy)');
});

test('excluding a field drops its value; including only clears the flag', () => {
    const profile = { id: 'p', name: 'Work', model: 'gpt-5', exclude: [] };
    setExcluded(profile, 'model', true);
    assert.deepEqual(profile.exclude, ['model']);
    assert.equal('model' in profile, false);
    assert.equal(isExcluded(profile, 'model'), true);
    // Excluding twice must not duplicate the entry.
    setExcluded(profile, 'model', true);
    assert.deepEqual(profile.exclude, ['model']);
    setExcluded(profile, 'model', false);
    assert.deepEqual(profile.exclude, []);
    assert.equal(isExcluded(profile, 'model'), false);
});

test('empty values delete the key unless the field allows empty strings', () => {
    const profile = { id: 'p', model: 'gpt-5' };
    assert.equal(setFieldValue(profile, 'model', ''), true);
    assert.equal('model' in profile, false);
    assert.equal(setFieldValue(profile, 'model', ''), false);
    assert.equal(setFieldValue(profile, 'stop-strings', ''), true);
    assert.equal(profile['stop-strings'], '');
    assert.equal(setFieldValue(profile, 'model', 'gpt-5'), true);
    assert.equal(setFieldValue(profile, 'model', 'gpt-5'), false);
    assert.equal(setFieldValue(profile, 'model', null), true);
    assert.equal('model' in profile, false);
});

test('API choices are filtered to the profile mode', () => {
    assert.deepEqual(apiChoices('cc', API_MAP).map((choice) => choice.value), ['claude', 'custom', 'openai']);
    assert.deepEqual(apiChoices('tc', API_MAP).map((choice) => choice.value), ['kobold', 'textgenerationwebui']);
    assert.equal(modeForApi('claude', API_MAP), 'cc');
    assert.equal(modeForApi('kobold', API_MAP), 'tc');
    assert.equal(modeForApi('missing', API_MAP), 'tc');
});

test('switching modes prunes the fields of the other mode', () => {
    const profile = {
        id: 'p',
        name: 'Work',
        mode: 'tc',
        api: 'kobold',
        model: 'koboldcpp',
        sysprompt: 'Chat',
        instruct: 'Alpaca',
        exclude: ['tokenizer', 'prompt-post-processing'],
    };
    pruneToMode(profile, 'cc');
    assert.equal(profile.mode, 'cc');
    assert.equal(profile.api, 'kobold');
    assert.equal('sysprompt' in profile, false);
    assert.equal('instruct' in profile, false);
    assert.deepEqual(profile.exclude, ['prompt-post-processing']);
    assert.equal(profile.id, 'p');
    assert.equal(profile.name, 'Work');
});

test('blank profiles and summaries', () => {
    assert.deepEqual(blankProfile('id-1', 'tc', 'New'), { id: 'id-1', mode: 'tc', name: 'New', exclude: [] });
    assert.equal(blankProfile('id-2', 'bogus', 'New').mode, 'cc');
    assert.equal(profileSummary({ api: 'claude', model: 'opus' }), 'claude · opus');
    assert.equal(profileSummary({ api: 'claude' }), 'claude');
    assert.equal(profileSummary({}), '—');
});

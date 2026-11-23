// Language on arrival: the visitor's own choice first, otherwise the phone's language, otherwise French.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLanguage } from '../Zeyd/i18n.js';

test('an Arabic phone opens the site in Arabic, any other phone in French', () => {
    assert.equal(detectLanguage(null, 'ar'), 'ar');
    assert.equal(detectLanguage(null, 'ar-SA'), 'ar');
    assert.equal(detectLanguage(null, 'AR-ma'), 'ar');
    assert.equal(detectLanguage(null, 'fr-FR'), 'fr');
    assert.equal(detectLanguage(null, 'en-US'), 'fr');
    assert.equal(detectLanguage(null, ''), 'fr');
    assert.equal(detectLanguage(null, 'arn'), 'fr', 'Mapudungun is not Arabic');
});

test('the FR / ع choice made on the site always wins over the phone language', () => {
    assert.equal(detectLanguage('fr', 'ar-SA'), 'fr');
    assert.equal(detectLanguage('ar', 'fr-FR'), 'ar');
    assert.equal(detectLanguage('xx', 'ar'), 'ar', 'an unknown saved value is ignored');
});

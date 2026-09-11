import request from '@/utils/request';
import {
  ensurePreferenceSuccess,
  parsePreferences,
  type PreferencePatch,
} from '../../shared/listeningPreferences';

export async function getListeningPreferences() {
  return parsePreferences(await request.get('/user/preference'));
}

export async function updateListeningPreferences(patch: PreferencePatch) {
  if (!Object.keys(patch).length) return;
  ensurePreferenceSuccess(await request.post('/user/preference/update', patch));
}

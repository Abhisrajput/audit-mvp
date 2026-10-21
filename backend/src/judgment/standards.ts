// The standards map (spec §4): which clause of the methodology pack each judgment
// cites. Constants only. Task 4's test checks these ids against the loaded pack.

export const METHODOLOGY_PACK_ID = 'iia';

/** The clause each judgment cites (spec §4). Ids are checked against the loaded pack in Task 4's test. */
export const IIA = {
  dueCare: 'IIA-4.2', scepticism: 'IIA-4.3', communication: 'IIA-13.1', riskAssessment: 'IIA-13.2', scope: 'IIA-13.3',
  criteria: 'IIA-13.4', resources: 'IIA-13.5', workProgram: 'IIA-13.6', gathering: 'IIA-14.1', analysis: 'IIA-14.2',
  evaluation: 'IIA-14.3', recommendations: 'IIA-14.4', conclusions: 'IIA-14.5', documentation: 'IIA-14.6',
  finalCommunication: 'IIA-15.1', followUp: 'IIA-15.2',
} as const;

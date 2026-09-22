import type { EvalCase } from '../types.js'
import {
  analysisDataGapCase, analysisFirstResearchCase, analysisFlatModeSymbolIsolationCase, analysisFlatWebSearchGateCase, analysisFollowUpChatCase,
  analysisHiddenToolCase, analysisSpecialistsOrchestrationCase, analysisStopFencesCase, analysisToolRoundLimitCase,
} from './analysis.js'
import { conversationDirectAnswerCase, conversationSymbolProjectionCase } from './conversation.js'

export const cases: EvalCase[] = [
  analysisFirstResearchCase,
  analysisFlatWebSearchGateCase,
  analysisDataGapCase,
  analysisFollowUpChatCase,
  analysisToolRoundLimitCase,
  analysisFlatModeSymbolIsolationCase,
  analysisSpecialistsOrchestrationCase,
  analysisStopFencesCase,
  analysisHiddenToolCase,
  conversationDirectAnswerCase,
  conversationSymbolProjectionCase,
]

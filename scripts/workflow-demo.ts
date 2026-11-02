/** Run the shared isolated controlled workflow scenario; retain all toy evidence. */
import { runPlanningDemo } from '../tests/workflow/scripted-epic-demo.js';
const result = await runPlanningDemo();
console.log(
  JSON.stringify(
    {
      outcome: 'planning-accepted',
      evidenceDirectory: result.directory,
      run: result.run.id,
      planning: result.planning,
      evidenceLevel: result.evidenceLevel,
    },
    null,
    2,
  ),
);

/** Run the shared isolated controlled workflow scenario; retain all toy evidence. */
import { runDeliveryDemo } from '../tests/workflow/scripted-epic-demo.js';
const result = await runDeliveryDemo();
console.log(
  JSON.stringify(
    {
      outcome: 'delivery-accepted',
      evidenceDirectory: result.directory,
      run: result.run.id,
      planning: result.planning,
      implementation: result.implementation,
      cleanup: result.cleanup,
      archive: result.archive,
      evidenceLevel: result.evidenceLevel,
    },
    null,
    2,
  ),
);

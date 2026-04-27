import type { Store } from "./store";
import { createInterface } from "readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

export async function runReviewer(store: Store): Promise<void> {
  const pending = store.getPendingComments();

  if (pending.length === 0) {
    console.log("No comments pending review. Run 'generate' first.");
    rl.close();
    return;
  }

  console.log(`\n${pending.length} comments pending review\n`);
  console.log("Commands: [a]pprove  [e]dit  [r]eject  [s]kip  [q]uit\n");

  let reviewed = 0;
  let approved = 0;
  let rejected = 0;

  for (const comment of pending) {
    console.log("─".repeat(60));
    console.log(`Post by: ${comment.authorName}`);
    console.log(`URL: ${comment.postUrl}`);
    console.log(`Post: "${comment.postContent.slice(0, 200)}..."`);
    console.log();
    console.log(`Comment: "${comment.comment_text}"`);
    console.log();

    const action = await ask("Action [a/e/r/s/q]: ");

    switch (action.toLowerCase().trim()) {
      case "a":
      case "approve": {
        store.updateCommentStatus(comment.id, "approved");
        approved++;
        reviewed++;
        console.log("  -> Approved\n");
        break;
      }
      case "e":
      case "edit": {
        const newText = await ask("New comment text: ");
        if (newText.trim()) {
          store.updateCommentStatus(comment.id, "approved", {
            text: newText.trim(),
          });
          approved++;
          reviewed++;
          console.log("  -> Edited & approved\n");
        } else {
          console.log("  -> Skipped (empty edit)\n");
        }
        break;
      }
      case "r":
      case "reject": {
        store.updateCommentStatus(comment.id, "rejected");
        rejected++;
        reviewed++;
        console.log("  -> Rejected\n");
        break;
      }
      case "s":
      case "skip": {
        console.log("  -> Skipped\n");
        break;
      }
      case "q":
      case "quit": {
        console.log(
          `\nReview session: ${reviewed} reviewed (${approved} approved, ${rejected} rejected)`
        );
        rl.close();
        return;
      }
      default: {
        console.log("  -> Unknown command, skipping\n");
        break;
      }
    }
  }

  console.log(
    `\nReview complete: ${reviewed} reviewed (${approved} approved, ${rejected} rejected)`
  );
  rl.close();
}

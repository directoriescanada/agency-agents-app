//! Team tasks: a lead plans a split, members work their parts side by
//! side, the lead merges the parts into one deliverable.
//!
//! Three kinds of record come out of one team task (see [`TaskKind`]):
//! the `team` record belongs to the lead and carries the merged
//! deliverable; each member's share is a `part` record that points back at
//! it. Parts cost what their own runs cost; the team record carries only
//! the planning call and the merge, so summing every record never counts
//! anything twice.
//!
//! Every run goes through the same runner and the same read-only tool
//! policy as a solo task ([`super::run_task`]).

use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::Semaphore;

use super::{
    absorb, agency_or_default, clean_prompt, finish, oneshot, register, run_and_record, run_ctx,
    run_task, system_prompt, RunCtx, StopSignal, TaskEvent, TaskKind, TaskRecord, TaskStatus,
    TeamPhase, TASK_EVENT,
};
use crate::error::AppError;
use crate::state::AppState;
use crate::types::Agent;

/// A lead never hands out more parts than this.
const MAX_MEMBERS: usize = 5;
/// The lead is never shown more candidates than this.
const MAX_ROSTER: usize = 80;
/// Parts running at the same time.
const MAX_PARALLEL: usize = 4;
/// How much of each part the merge prompt carries inline. The whole text
/// is on disk for the lead to read when a part is longer.
const PART_INLINE_CHARS: usize = 6_000;
/// The planning call: one answer, no tools.
const PLAN_MODEL: &str = "sonnet";
const PLAN_TIMEOUT_SECS: u64 = 120;

/// One line of the lead's plan.
#[derive(Debug, Clone, PartialEq)]
struct Assignment {
    slug: String,
    brief: String,
}

// ---------- The plan ----------

/// Read the lead's plan out of a model reply: the first JSON array of
/// assignments in it, whatever prose or fencing surrounds it. Unknown and
/// repeated slugs are dropped, as are empty briefs; at most `max` survive.
fn parse_plan(answer: &str, valid: &[String], max: usize) -> Vec<Assignment> {
    const SLUG_KEYS: [&str; 4] = ["agentSlug", "agent_slug", "slug", "agent"];
    const BRIEF_KEYS: [&str; 3] = ["brief", "task", "part"];
    let text_of = |item: &serde_json::Value, keys: &[&str]| -> String {
        keys.iter()
            .find_map(|k| item.get(*k).and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string()
    };

    for (at, _) in answer.match_indices('[') {
        // A stream deserializer reads one value and ignores what follows,
        // so trailing prose or a closing fence does no harm.
        let mut stream =
            serde_json::Deserializer::from_str(&answer[at..]).into_iter::<serde_json::Value>();
        let Some(Ok(serde_json::Value::Array(items))) = stream.next() else {
            continue;
        };
        let mut plan: Vec<Assignment> = Vec::new();
        for item in &items {
            let slug = text_of(item, &SLUG_KEYS);
            let slug = slug.trim_matches(|c| c == '`' || c == '"' || c == '\'');
            let brief = text_of(item, &BRIEF_KEYS);
            if brief.is_empty()
                || !valid.iter().any(|v| v == slug)
                || plan.iter().any(|a| a.slug == slug)
            {
                continue;
            }
            plan.push(Assignment {
                slug: slug.to_string(),
                brief,
            });
            if plan.len() == max {
                break;
            }
        }
        if !plan.is_empty() {
            return plan;
        }
    }
    Vec::new()
}

/// What a member is asked for when the plan says nothing about them.
fn default_brief(agent: &Agent) -> String {
    let what = agent.description.trim();
    if what.is_empty() {
        format!("Cover the side of this task that falls to you as {}.", agent.name)
    } else {
        format!(
            "Cover the side of this task that falls to you as {}: {what}",
            agent.name
        )
    }
}

/// With a team the user chose, every member gets a part, in the team's
/// order: the lead's brief where there is one, a general one otherwise.
fn plan_for_fixed_team(plan: Vec<Assignment>, roster: &[Agent]) -> Vec<Assignment> {
    roster
        .iter()
        .map(|agent| {
            plan.iter()
                .find(|a| a.slug == agent.slug)
                .cloned()
                .unwrap_or_else(|| Assignment {
                    slug: agent.slug.clone(),
                    brief: default_brief(agent),
                })
        })
        .collect()
}

// ---------- Prompts ----------

fn plan_prompt(lead: &Agent, agency: &str, task: &str, roster: &[Agent], fixed: bool) -> String {
    let mut lines = String::new();
    for a in roster {
        let desc: String = a.description.chars().take(140).collect();
        lines.push_str(&format!("{} | {} | {} | {}\n", a.slug, a.name, a.category, desc));
    }
    let who = if fixed {
        "Give every member of the team exactly one part.".to_string()
    } else {
        format!(
            "Choose the 2 to {MAX_MEMBERS} members best suited to it. Prefer fewer when the task is small."
        )
    };
    format!(
        "You are {name}, leading a team at {agency}. Split the task below into parts for your team.\n\n\
TASK:\n{task}\n\n\
TEAM (slug | name | department | what they do):\n{lines}\n\
{who} Each part is a brief its member can finish alone: what to produce, what to cover, and what to \
leave to the others. Parts must not overlap. Members can search and read the web; they cannot edit \
files or run commands. You will merge their work into the final deliverable yourself, so do not give \
yourself a part.\n\n\
Reply with only a JSON array and no other text:\n\
[{{\"agentSlug\": \"<slug from the team>\", \"brief\": \"<two to four sentences>\"}}]",
        name = lead.name,
    )
}

/// What a member's run is given: the whole task for context, their own
/// brief, and what the others are covering so the parts stay apart.
fn part_prompt(lead: &Agent, task: &str, mine: &Assignment, others: &[(String, String)]) -> String {
    let mut out = format!(
        "You are working on one part of a team task led by {lead}.\n\n\
THE WHOLE TASK (context only; do not do all of it):\n{task}\n\n\
YOUR PART:\n{brief}\n",
        lead = lead.name,
        brief = mine.brief,
    );
    if !others.is_empty() {
        out.push_str("\nYOUR TEAMMATES ARE COVERING:\n");
        for (name, brief) in others {
            out.push_str(&format!("- {name}: {brief}\n"));
        }
    }
    out.push_str(&format!(
        "\nStay within your part. {lead} will merge everyone's work into the final deliverable, so \
write a self-contained section in Markdown, lead with the substance and leave out any account of \
the process.",
        lead = lead.name,
    ));
    out
}

/// What the lead's merge run is given. `dir` is the folder, relative to
/// the run's working directory, that holds each part in full.
fn merge_prompt(task: &str, parts: &[TaskRecord], dir: &str) -> String {
    let mut out = format!(
        "Your team has finished. Merge their work into the final deliverable for the task below.\n\n\
TASK:\n{task}\n\nPARTS:\n"
    );
    for part in parts {
        let brief = part.brief.as_deref().unwrap_or("");
        out.push_str(&format!("\n=== {} ({}) ===\nBrief: {brief}\n\n", part.agent_name, part.agent_slug));
        if part.status != TaskStatus::Done {
            out.push_str("[This part was not finished. Cover the gap briefly, or say plainly what is missing.]\n");
            continue;
        }
        let total = part.output.chars().count();
        if total > PART_INLINE_CHARS {
            let head: String = part.output.chars().take(PART_INLINE_CHARS).collect();
            out.push_str(&head);
            out.push_str(&format!(
                "\n[Cut here. The rest is in {dir}/part-{}.md; read it before you merge.]\n",
                part.agent_slug
            ));
        } else {
            out.push_str(part.output.trim_end());
            out.push('\n');
        }
    }
    out.push_str(
        "\nWrite one coherent document in Markdown. Resolve overlaps and contradictions, keep the \
strongest material and every source the parts cite, and fill small gaps yourself. Do not describe \
the merge or the team: reply with the deliverable itself.",
    );
    out
}

// ---------- The command ----------

/// Hand a task to a team. `lead_slug` plans the split and merges the
/// result. `member_slugs` is a team the user chose (a preset or a saved
/// one); when it is empty the lead picks its own from `candidate_slugs`.
/// Returns the team's record at once; progress arrives as `office:task`
/// events, the parts as tasks of their own.
#[tauri::command]
pub async fn office_team_start(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    lead_slug: String,
    member_slugs: Vec<String>,
    candidate_slugs: Vec<String>,
    agency_name: Option<String>,
) -> Result<TaskRecord, AppError> {
    let task = clean_prompt(&prompt)?;
    state.require_network("office_team").await?;
    let ctx = run_ctx(&app, &state)?;

    let corpus = crate::corpus::ensure_corpus(&app, &state).await?;
    let lead = corpus.get(&lead_slug).ok_or_else(|| AppError::InvalidArgument {
        message: format!("unknown agent `{lead_slug}`"),
    })?;

    let chosen = !member_slugs.is_empty();
    let pool = if chosen { &member_slugs } else { &candidate_slugs };
    let mut roster: Vec<Agent> = Vec::new();
    for slug in pool {
        if *slug == lead.slug || roster.iter().any(|a| a.slug == *slug) {
            continue;
        }
        if let Some(agent) = corpus.get(slug) {
            roster.push(agent);
        }
        if roster.len() == MAX_ROSTER {
            break;
        }
    }
    if roster.is_empty() {
        return Err(AppError::InvalidArgument {
            message: "a team needs at least one member besides its lead".into(),
        });
    }
    // A chosen team too big to give everyone a part is a pool to pick from.
    let fixed = chosen && roster.len() <= MAX_MEMBERS;
    let agency = agency_or_default(agency_name);

    let mut record = TaskRecord::new(&lead, &task);
    record.kind = TaskKind::Team;
    record.phase = Some(TeamPhase::Planning);
    let stop = register(&ctx, &record).await;
    let parent = record.clone();
    tauri::async_runtime::spawn(async move {
        run_team(ctx, parent, lead, roster, fixed, agency, stop).await;
    });

    Ok(record)
}

// ---------- The run ----------

fn emit_phase(ctx: &RunCtx, parent: &TaskRecord) {
    let Some(phase) = parent.phase else { return };
    let _ = ctx.app.emit(
        TASK_EVENT,
        TaskEvent::Phase {
            task_id: parent.id.clone(),
            phase,
            members: parent.members.clone(),
        },
    );
}

/// Close a team task that ended before its merge.
async fn end_early(
    ctx: &RunCtx,
    mut parent: TaskRecord,
    status: TaskStatus,
    error: Option<&str>,
    cost: Option<f64>,
    began: Instant,
) {
    parent.status = status;
    parent.error = error.map(str::to_string);
    parent.cost_usd = cost;
    parent.duration_ms = Some(began.elapsed().as_millis() as u64);
    finish(ctx, parent, &[]).await;
}

/// One member's part, from the wait for a free slot to its recorded end.
/// Stopping the team stops the part; stopping the part leaves the team
/// running.
async fn run_part(
    ctx: RunCtx,
    mut rec: TaskRecord,
    prompt: String,
    system: String,
    part_stop: Arc<StopSignal>,
    team_stop: Arc<StopSignal>,
    slots: Arc<Semaphore>,
) -> TaskRecord {
    let permit = tokio::select! {
        _ = part_stop.wait() => None,
        _ = team_stop.wait() => None,
        permit = slots.acquire_owned() => permit.ok(),
    };
    let Some(_permit) = permit else {
        rec.status = TaskStatus::Cancelled;
        return finish(&ctx, rec, &[]).await;
    };
    let run = run_and_record(&ctx, rec, prompt, system, part_stop.clone());
    tokio::pin!(run);
    tokio::select! {
        rec = &mut run => rec,
        _ = team_stop.wait() => {
            part_stop.stop();
            run.await
        }
    }
}

async fn run_team(
    ctx: RunCtx,
    mut parent: TaskRecord,
    lead: Agent,
    roster: Vec<Agent>,
    fixed: bool,
    agency: String,
    stop: Arc<StopSignal>,
) {
    let began = Instant::now();
    let task = parent.prompt.clone();

    // 1. Planning: one call, no tools. Dropping it kills the child.
    let ask = plan_prompt(&lead, &agency, &task, &roster, fixed);
    let planned = tokio::select! {
        _ = stop.wait() => None,
        reply = oneshot(&ctx, &ask, PLAN_MODEL, PLAN_TIMEOUT_SECS) => Some(reply),
    };
    let Some((answer, plan_cost)) = planned else {
        return end_early(&ctx, parent, TaskStatus::Cancelled, None, None, began).await;
    };
    let valid: Vec<String> = roster.iter().map(|a| a.slug.clone()).collect();
    let mut plan = parse_plan(&answer, &valid, MAX_MEMBERS);
    if fixed {
        plan = plan_for_fixed_team(plan, &roster);
    }
    if plan.is_empty() {
        let why = if answer.trim().is_empty() {
            "the lead's planning call did not come back"
        } else {
            "the lead's plan could not be read"
        };
        return end_early(&ctx, parent, TaskStatus::Error, Some(why), plan_cost, began).await;
    }

    // 2. Working: every part is announced at once, so the whole team shows
    // up together; at most MAX_PARALLEL of them run at a time.
    parent.members = plan.iter().map(|a| a.slug.clone()).collect();
    parent.phase = Some(TeamPhase::Working);
    emit_phase(&ctx, &parent);

    let slots = Arc::new(Semaphore::new(MAX_PARALLEL));
    let mut handles = Vec::new();
    for mine in &plan {
        let Some(member) = roster.iter().find(|a| a.slug == mine.slug) else {
            continue;
        };
        let mut rec = TaskRecord::new(member, &task);
        rec.kind = TaskKind::Part;
        rec.parent_id = Some(parent.id.clone());
        rec.brief = Some(mine.brief.clone());

        let others: Vec<(String, String)> = plan
            .iter()
            .filter(|a| a.slug != mine.slug)
            .filter_map(|a| {
                let name = roster.iter().find(|r| r.slug == a.slug)?.name.clone();
                Some((name, a.brief.clone()))
            })
            .collect();
        let prompt = part_prompt(&lead, &task, mine, &others);
        let system = system_prompt(member, &agency);
        let part_stop = register(&ctx, &rec).await;
        let fallback = rec.clone();
        let handle = tauri::async_runtime::spawn(run_part(
            ctx.clone(),
            rec,
            prompt,
            system,
            part_stop,
            stop.clone(),
            slots.clone(),
        ));
        handles.push((handle, fallback));
    }

    let mut parts: Vec<TaskRecord> = Vec::new();
    for (handle, mut fallback) in handles {
        match handle.await {
            Ok(rec) => parts.push(rec),
            Err(e) => {
                // The part's own task died before it could record itself.
                tracing::warn!("office: a team part broke off: {e}");
                fallback.status = TaskStatus::Error;
                fallback.error = Some("this part's run broke off".into());
                parts.push(finish(&ctx, fallback, &[]).await);
            }
        }
    }

    if stop.is_stopped() {
        return end_early(&ctx, parent, TaskStatus::Cancelled, None, plan_cost, began).await;
    }
    if !parts.iter().any(|p| p.status == TaskStatus::Done) {
        let why = "no part of the task was finished";
        return end_early(&ctx, parent, TaskStatus::Error, Some(why), plan_cost, began).await;
    }

    // 3. Merging: the lead's own run, streamed under the team's id.
    parent.phase = Some(TeamPhase::Merging);
    emit_phase(&ctx, &parent);

    let rel = format!("teams/{}", parent.id);
    let dir = ctx.workspace.join(&rel);
    if std::fs::create_dir_all(&dir).is_ok() {
        for part in parts.iter().filter(|p| p.status == TaskStatus::Done) {
            let file = dir.join(format!("part-{}.md", part.agent_slug));
            if let Err(e) = std::fs::write(&file, &part.output) {
                tracing::warn!("office: {} not written: {e}", file.display());
            }
        }
    }
    let outcome = run_task(
        ctx.app.clone(),
        ctx.bin.clone(),
        ctx.workspace.clone(),
        parent.id.clone(),
        merge_prompt(&task, &parts, &rel),
        system_prompt(&lead, &agency),
        stop.clone(),
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);

    absorb(&mut parent, outcome);
    // Planning plus merge. The parts carry their own cost.
    parent.cost_usd = match (plan_cost, parent.cost_usd) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    };
    parent.duration_ms = Some(began.elapsed().as_millis() as u64);
    if parent.status == TaskStatus::Done {
        parent.phase = Some(TeamPhase::Done);
    }
    finish(&ctx, parent, &parts).await;
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(slug: &str, name: &str) -> Agent {
        Agent {
            slug: slug.into(),
            name: name.into(),
            description: format!("{name} does {slug} work"),
            category: "engineering".into(),
            emoji: None,
            color: None,
            vibe: None,
            body: String::new(),
        }
    }

    fn valid() -> Vec<String> {
        ["a", "b", "c", "d", "e", "f", "g"].iter().map(|s| s.to_string()).collect()
    }

    fn slugs(plan: &[Assignment]) -> Vec<&str> {
        plan.iter().map(|a| a.slug.as_str()).collect()
    }

    #[test]
    fn plan_is_read_from_bare_json() {
        let plan = parse_plan(
            r#"[{"agentSlug": "a", "brief": "Do the first half."}, {"agentSlug": "b", "brief": "Do the rest."}]"#,
            &valid(),
            5,
        );
        assert_eq!(slugs(&plan), ["a", "b"]);
        assert_eq!(plan[1].brief, "Do the rest.");
    }

    #[test]
    fn plan_survives_fences_and_prose() {
        let answer = "Here is the split:\n\n```json\n[\n  {\"agentSlug\": \"c\", \"brief\": \"Research.\"},\n  {\"slug\": \"`d`\", \"task\": \"Write up.\"}\n]\n```\nLet me know if you want changes.";
        let plan = parse_plan(answer, &valid(), 5);
        assert_eq!(slugs(&plan), ["c", "d"]);
        assert_eq!(plan[1].brief, "Write up.");
    }

    #[test]
    fn plan_drops_unknown_repeated_and_empty_entries() {
        let answer = r#"[
            {"agentSlug": "nobody", "brief": "x"},
            {"agentSlug": "a", "brief": "first"},
            {"agentSlug": "a", "brief": "again"},
            {"agentSlug": "b", "brief": "   "},
            {"agentSlug": "c"},
            "not an object",
            {"agentSlug": "d", "brief": "last"}
        ]"#;
        let plan = parse_plan(answer, &valid(), 5);
        assert_eq!(slugs(&plan), ["a", "d"]);
        assert_eq!(plan[0].brief, "first");
    }

    #[test]
    fn plan_is_capped() {
        let items: Vec<String> = valid()
            .iter()
            .map(|s| format!(r#"{{"agentSlug": "{s}", "brief": "part {s}"}}"#))
            .collect();
        let plan = parse_plan(&format!("[{}]", items.join(",")), &valid(), 5);
        assert_eq!(slugs(&plan), ["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn plan_skips_brackets_that_are_not_the_plan() {
        let answer = r#"Per the brief [1] and the roster [a, b]: [{"agentSlug": "b", "brief": "All of it."}]"#;
        assert_eq!(slugs(&parse_plan(answer, &valid(), 5)), ["b"]);
    }

    #[test]
    fn no_plan_in_the_reply_is_an_empty_plan() {
        assert!(parse_plan("", &valid(), 5).is_empty());
        assert!(parse_plan("I cannot split this.", &valid(), 5).is_empty());
        assert!(parse_plan("[]", &valid(), 5).is_empty());
        assert!(parse_plan("[{\"agentSlug\": \"a\", \"brief\": \"cut off", &valid(), 5).is_empty());
    }

    #[test]
    fn a_fixed_team_gives_every_member_a_part_in_team_order() {
        let roster = vec![agent("a", "Ada"), agent("b", "Bo"), agent("c", "Cy")];
        let plan = vec![Assignment {
            slug: "c".into(),
            brief: "Cy's own brief".into(),
        }];
        let plan = plan_for_fixed_team(plan, &roster);
        assert_eq!(slugs(&plan), ["a", "b", "c"]);
        assert!(plan[0].brief.contains("Ada"));
        assert_eq!(plan[2].brief, "Cy's own brief");
    }

    #[test]
    fn plan_prompt_lists_the_roster_and_states_the_rule() {
        let lead = agent("lead", "Lee");
        let roster = vec![agent("a", "Ada"), agent("b", "Bo")];
        let picked = plan_prompt(&lead, "Oz Agency", "Launch plan", &roster, false);
        assert!(picked.starts_with("You are Lee, leading a team at Oz Agency."));
        assert!(picked.contains("a | Ada | engineering | Ada does a work\n"));
        assert!(picked.contains("Choose the 2 to 5 members"));
        assert!(picked.contains(r#"[{"agentSlug": "<slug from the team>""#));
        let fixed = plan_prompt(&lead, "Oz Agency", "Launch plan", &roster, true);
        assert!(fixed.contains("Give every member of the team exactly one part."));
    }

    #[test]
    fn part_prompt_carries_the_brief_and_the_teammates() {
        let lead = agent("lead", "Lee");
        let mine = Assignment {
            slug: "a".into(),
            brief: "Price the options.".into(),
        };
        let others = vec![("Bo".to_string(), "Check the law.".to_string())];
        let p = part_prompt(&lead, "Launch plan", &mine, &others);
        assert!(p.contains("YOUR PART:\nPrice the options.\n"));
        assert!(p.contains("- Bo: Check the law.\n"));
        assert!(p.contains("Lee will merge"));
        assert!(!part_prompt(&lead, "Launch plan", &mine, &[]).contains("TEAMMATES"));
    }

    #[test]
    fn merge_prompt_cuts_long_parts_and_names_unfinished_ones() {
        let mut long = TaskRecord::new(&agent("a", "Ada"), "Launch plan");
        long.status = TaskStatus::Done;
        long.brief = Some("Price the options.".into());
        long.output = "x".repeat(PART_INLINE_CHARS + 50);
        let mut short = TaskRecord::new(&agent("b", "Bo"), "Launch plan");
        short.status = TaskStatus::Done;
        short.output = "Short and whole.\n\n".into();
        let mut failed = TaskRecord::new(&agent("c", "Cy"), "Launch plan");
        failed.status = TaskStatus::Error;
        failed.output = "half a thought".into();

        let p = merge_prompt("Launch plan", &[long, short, failed], "teams/t1");
        assert!(p.contains("=== Ada (a) ===\nBrief: Price the options.\n"));
        assert!(p.contains(&format!("{}\n[Cut here.", "x".repeat(PART_INLINE_CHARS))));
        assert!(!p.contains(&"x".repeat(PART_INLINE_CHARS + 1)));
        assert!(p.contains("teams/t1/part-a.md"));
        assert!(p.contains("Short and whole.\n\n=== Cy (c) ==="));
        assert!(p.contains("[This part was not finished."));
        assert!(!p.contains("half a thought"));
    }

    #[tokio::test]
    async fn a_stop_reaches_every_waiter_and_those_who_come_late() {
        let stop = Arc::new(StopSignal::default());
        assert!(!stop.is_stopped());
        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let stop = stop.clone();
                tokio::spawn(async move { stop.wait().await })
            })
            .collect();
        tokio::task::yield_now().await;
        stop.stop();
        for w in waiters {
            tokio::time::timeout(std::time::Duration::from_secs(2), w)
                .await
                .expect("a waiter was left asleep")
                .unwrap();
        }
        assert!(stop.is_stopped());
        // Already stopped: resolves at once.
        tokio::time::timeout(std::time::Duration::from_secs(2), stop.wait())
            .await
            .expect("a late waiter was left asleep");
    }
}

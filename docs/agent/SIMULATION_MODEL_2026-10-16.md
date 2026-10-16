# Why the simulation did not run on Meital's model (16/10, no run and no prompt change)

## Findings (checked)
1. **The agent configuration is correct:**
   - `agtvrsn_4801…`: `llm = claude-sonnet-5`, `backup_llm_config = default`, `cascade_timeout_seconds = 4`.
   - The same applies to the earlier version `agtvrsn_6701…`.
2. **A real conversation uses Meital's model:** `conv_7301m4v990tcegea4wy574py7efp` (the barbershop, widget, version 6901). All 10 agent replies came from `producing_llm = claude-sonnet-5`, with no `llm_override`. The charge was for claude-sonnet-5 only.
3. **Simulations do not use Meital's model:**
   - **ACC-04 (16/10):** every generated agent turn is marked `llm_override = gemini-2.5-flash`, and one turn `gpt-4o`.
   - **The snooker run (`suite_9101m4hyy3crfn6vbk04hvz7d3wm`, 11/10, version 6701):** the same pattern. gemini-2.5-flash alternates with gpt-4o, and only the fixed opening message is marked claude-sonnet-5, because it is not generated.
   - So this is not a one-off fault. **Every text simulation on this agent so far ran on a different model.** That includes the conclusions from the earlier simulations of 11/10.
4. **The override is set by the test service, not by the agent:**
   - The `llm_override` field appears only in simulations.
   - The test definition (`UpdateSimulationTestRequest`) has no field for the agent's model. There are fields only for the simulated user and the evaluator.
   - The gpt-4o turns are probably the default backup in the cascade after gemini. That is an inference; I did not verify it.

## Not verified
- **Why the test service replaces the model.** Two possibilities:
  - It does not support claude-sonnet-5 in simulations;
  - or it always replaces the model with a default.
- **No documentation on this.** The ElevenLabs documentation is not reachable from this environment (DNS), and a web search found no official statement.
- **Whether `agent_config_override` in `run_tests` (a full configuration with `llm = claude-sonnet-5`) prevents the replacement.** It can only be checked with a run, and that has not been approved.

## How the next test will use Meital's model: two routes
| Route | What it guarantees | Cost (estimate) | Risk |
|---|---|---|---|
| **A. A real text conversation on Preview** (Chrome plays Dana in the widget, in text mode) | **Meital's model, guaranteed.** Real conversations run on claude-sonnet-5, as checked in finding 2 | About 1,000–1,500 credits for 10 turns, by the barbershop measurement (about 115 LLM credits per turn) plus the text-message fee. Not a guaranteed cap | The tools are real on Preview: saving to the Preview database. open_payment opens a PayPal **sandbox** window only if Meital calls it. The customer is played by a person, not by a simulator |
| **B. A simulation with `agent_config_override`** | Not guaranteed. The test service may ignore it | **A small check first:** one test of 1–2 turns, about 30–60 credits, only to see `producing_llm`. If it works, ACC-04 again at about 1,000–1,500 credits on Meital's model | If the override is ignored, the check money is spent without a result. The override is a full copy of the 4801 configuration, so any copying mistake changes the test |

**Recommendation: A.** It is the only route that verifies Meital in the conditions of a real customer. It also matches the remaining acceptance tests, which are live on Preview.

Route B is worth it only if we want automated simulations for many scenarios. In that case the small check first, with separate approval.

**In any case:** every future simulation report starts by checking `producing_llm` in every agent turn. If it is not claude-sonnet-5, that is stated before any conclusion.

## Identification check with an explicit override (16/10, one approved run)
- **Run:** `suite_1501m51beejqfv19teskn469dd2k` / `trun_9601m51beejtee6vsw63mkph52xb`.
  - **Test:** `test_2701m51bbwb2ftztmrrg2t4wybw7`, 2 turns, all tools mocked.
- **Requested model:** `agent_config_override` with `conversation_config.agent.prompt.llm = claude-sonnet-5`, plus the full 4801 prompt and settings: reasoning_effort low, max_tokens 700, tool_ids and timezone.
  - The test service marked the run `ran_against_draft: true`. The agent and its published version were not changed.
- **Model that answered:** in both turns, `llm_override = gemini-2.5-flash` and `producing_llm = gemini-2.5-flash`. claude-sonnet-5 did not answer in any turn.
- **Actual cost:** 94 credits. LLM 34 (about $0.0071, gemini only) + platform 60 (4 text messages × 15).
- **Conclusion:** even an explicit override does not bring Meital's model into a simulation. **The simulation route is stopped.** The sales tests move to real conversations on the Preview site, which run on claude-sonnet-5 (checked in conv_7301).
- **Side observation, not about Meital:** gemini added tags such as "[נפלא]" and "[בטח]" at the start of its replies. In the second turn it offered to open the payment window right after a price question. That is the substitute model's behavior, and it says nothing about claude-sonnet-5.

package collaboration

import "time"

// Goal is one room-scoped completion contract, not permission to run local tools.
type Goal struct {
	ID        int       `json:"id"`
	Title     string    `json:"title"`
	Criteria  string    `json:"criteria"`
	Reviewer  string    `json:"reviewer"`
	Status    string    `json:"status"`
	CreatedBy string    `json:"createdBy"`
	Result    int       `json:"result,omitempty"`
	ResultBy  string    `json:"resultBy,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func humanMember(room *Room, id string, active bool) bool {
	for _, m := range room.Members {
		if m.ID == id && m.Kind == "human" && (!active || !m.Removed) {
			return true
		}
	}
	return false
}

func validGoal(room *Room) bool {
	if room.NextGoal < 0 || room.GoalRevision < 0 || room.Version == 1 && (room.Goal != nil || room.NextGoal != 0 || room.GoalRevision != 0) || room.Version == 2 && (room.NextGoal == 0 || room.GoalRevision == 0) {
		return false
	}
	g := room.Goal
	if g == nil {
		return true
	}
	if g.ID <= 0 || g.ID > room.NextGoal || room.GoalRevision == 0 || !validText(g.Title, 200, false) || !validText(g.Criteria, 4000, true) || !humanMember(room, g.Reviewer, false) || !humanMember(room, g.CreatedBy, false) || g.UpdatedAt.IsZero() {
		return false
	}
	if g.Status != "active" && g.Status != "paused" && g.Status != "review" && g.Status != "done" {
		return false
	}
	if g.Result < 0 || g.Result > len(room.Messages) || (g.Result > 0) != (g.ResultBy != "") || g.Result > 0 && room.Messages[g.Result-1].MemberID != g.ResultBy {
		return false
	}
	return (g.Status != "review" && g.Status != "done") || g.Result > 0
}

func goalView(room *Room) map[string]any {
	return map[string]any{"goal": room.Goal, "goalRevision": room.GoalRevision, "tasks": tasksView(room.Tasks)}
}

func goalTasksDone(room *Room) bool {
	for _, task := range room.Tasks {
		if task.GoalID == room.Goal.ID && task.Status != "done" {
			return false
		}
	}
	return true
}

// Called on the private room copy. Review authority never falls back to the owner.
func (s *Store) goal(room *Room, actor *Member, q request) error {
	if room.AIPaused && actor.Kind == "ai" {
		return fail(409, "AI_PAUSED")
	}
	if q.GoalRevision == nil || *q.GoalRevision < 0 {
		return fail(400, "INVALID_GOAL")
	}
	if *q.GoalRevision != room.GoalRevision {
		return fail(409, "GOAL_CHANGED")
	}
	if q.Action == "create" {
		if !actor.Owner {
			return fail(403, "OWNER_REQUIRED")
		}
		if room.Goal != nil && room.Goal.Status != "done" {
			return fail(409, "GOAL_EXISTS")
		}
		if q.GoalID != 0 || !validText(q.Title, 200, false) || !validText(q.Criteria, 4000, true) || !humanMember(room, q.Reviewer, true) {
			return fail(400, "INVALID_GOAL")
		}
		// Older relays reject v2 rather than silently discarding goal state on their next save.
		room.Version = 2
		room.NextGoal++
		room.Goal = &Goal{ID: room.NextGoal, Title: q.Title, Criteria: q.Criteria, Reviewer: q.Reviewer, Status: "active", CreatedBy: actor.ID, UpdatedAt: s.now()}
		// The room's unfinished board is the starting work for its single current goal.
		for i := range room.Tasks {
			if room.Tasks[i].Status != "done" {
				room.Tasks[i].GoalID = room.Goal.ID
			}
		}
	} else {
		g := room.Goal
		if g == nil || q.GoalID != g.ID {
			return fail(409, "GOAL_CHANGED")
		}
		switch q.Action {
		case "pause", "resume", "delete", "reviewer":
			if !actor.Owner {
				return fail(403, "OWNER_REQUIRED")
			}
			switch q.Action {
			case "pause":
				if g.Status != "active" {
					return fail(409, "GOAL_NOT_ACTIVE")
				}
				g.Status = "paused"
			case "resume":
				if g.Status != "paused" || !humanMember(room, g.Reviewer, true) {
					return fail(409, "GOAL_NOT_ACTIVE")
				}
				g.Status = "active"
			case "delete":
				room.Goal = nil // Keep tasks, messages and the monotonic revision.
			case "reviewer":
				if g.Status == "done" || !humanMember(room, q.Reviewer, true) {
					return fail(400, "INVALID_GOAL")
				}
				g.Reviewer = q.Reviewer
			}
		case "submit":
			if g.Status != "active" || !humanMember(room, g.Reviewer, true) {
				return fail(409, "GOAL_NOT_ACTIVE")
			}
			if !goalTasksDone(room) {
				return fail(409, "GOAL_TASKS_OPEN")
			}
			if q.ResultSeq <= 0 || q.ResultSeq > len(room.Messages) || room.Messages[q.ResultSeq-1].MemberID != actor.ID {
				return fail(400, "INVALID_RESULT")
			}
			g.Status, g.Result, g.ResultBy = "review", q.ResultSeq, actor.ID
		case "accept", "reject":
			if actor.ID != g.Reviewer || actor.Kind != "human" {
				return fail(403, "GOAL_REVIEWER_REQUIRED")
			}
			if g.Status != "review" {
				return fail(409, "GOAL_NOT_ACTIVE")
			}
			if q.Action == "accept" {
				if !goalTasksDone(room) {
					return fail(409, "GOAL_TASKS_OPEN")
				}
				g.Status = "done"
			} else {
				g.Status = "active"
			}
		default:
			return fail(400, "INVALID_GOAL")
		}
		g.UpdatedAt = s.now()
	}
	if q.Action != "pause" && q.Action != "delete" && !s.rate("send:"+room.ID+actor.ID, 20) {
		return fail(429, "RATE_LIMIT")
	}
	room.GoalRevision++
	return nil
}

// Losing the reviewer pauses ongoing work instead of silently appointing someone else.
func (s *Store) pauseGoalWithoutReviewer(room *Room) {
	if g := room.Goal; g != nil && g.Status != "done" && g.Status != "paused" && !humanMember(room, g.Reviewer, true) {
		g.Status, g.UpdatedAt = "paused", s.now()
		room.GoalRevision++
	}
}

func goalTaskWritable(room *Room, goalID int) error {
	if goalID != 0 && room.Goal != nil && goalID == room.Goal.ID && room.Goal.Status != "active" {
		return fail(409, "GOAL_NOT_ACTIVE")
	}
	return nil
}

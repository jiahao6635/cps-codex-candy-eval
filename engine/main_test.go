package main

import (
	"strings"
	"testing"
)

func TestCandyAndPelican(t *testing.T) {
	for _, tc := range []struct {
		answer  string
		correct bool
	}{{"答案 21。", true}, {"121", false}, {"210", false}, {"20", false}} {
		v, err := handle(Input{Op: "score", Kind: "candy", Jobs: []Job{{}}, Answers: []string{tc.answer}})
		if err != nil || v.(map[string]any)["correct"] != tc.correct {
			t.Fatal(tc, v, err)
		}
	}
	if extractCode("```svg\n<svg/>\n```") != "<svg/>" {
		t.Fatal("missing SVG")
	}
	if _, err := handle(Input{Op: "score", Kind: "pelican", Jobs: []Job{{}}, Answers: []string{"no code"}}); err == nil {
		t.Fatal("invalid drawing accepted")
	}
}
func TestPrepareAndCodexContext(t *testing.T) {
	v, err := handle(Input{Op: "prepare", Kind: "fingerprint"})
	if err != nil {
		t.Fatal(err)
	}
	jobs := v.([]Job)
	if len(jobs) != 3 {
		t.Fatal(len(jobs))
	}
	seen := map[string]bool{}
	for _, j := range jobs {
		if j.Expected < 80 || seen[j.Prompt] {
			t.Fatal(j)
		}
		seen[j.Prompt] = true
	}
	r, _ := codexTurn("account", "test-model", "low", "extra instructions", "question")
	if r.Model != "test-model" || !r.Stream || len(r.Input) < 6 {
		t.Fatal("incomplete request")
	}
	raw := string(codexContextJSON)
	if !strings.Contains(raw, "base_instructions") {
		t.Fatal("context missing")
	}
}

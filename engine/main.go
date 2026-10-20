package main

import (
	"bufio"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"regexp"
	"strings"
)

const fingerprintTarget = 3

func mustDecode[T any](raw []byte) T {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		panic(err)
	}
	return v
}

type Job struct {
	Prompt       string `json:"prompt"`
	Instructions string `json:"instructions"`
	Expected     int    `json:"expected_count"`
}
type Input struct {
	Op      string   `json:"op"`
	Kind    string   `json:"kind"`
	Variant string   `json:"variant"`
	Account string   `json:"account"`
	Model   string   `json:"model"`
	Effort  string   `json:"effort"`
	Job     Job      `json:"job"`
	Jobs    []Job    `json:"jobs"`
	Answers []string `json:"answers"`
}

var candyAnswer = regexp.MustCompile(`(^|[^0-9])21([^0-9]|$)`)
var codeBlock = regexp.MustCompile("(?s)```[ \\t]*(?:html|svg)?[^\\n]*\\n(.*?)\\n[ \\t]*```")

func extractCode(answer string) string {
	for _, block := range codeBlock.FindAllStringSubmatch(answer, -1) {
		if code := strings.TrimSpace(block[1]); strings.HasPrefix(code, "<") {
			return code
		}
	}
	if text := strings.TrimSpace(answer); strings.HasPrefix(text, "<") {
		return text
	}
	return ""
}
func handle(q Input) (any, error) {
	switch q.Op {
	case "prepare":
		switch q.Kind {
		case "candy":
			return []Job{{Prompt: candyPrompt}}, nil
		case "pelican":
			for _, v := range pelicanVariants {
				if v.ID == q.Variant {
					return []Job{{Prompt: v.Prompt}}, nil
				}
			}
		case "fingerprint":
			suite := mustDecode[[]struct {
				System   string `json:"system"`
				Prefix   string `json:"user_prefix"`
				Prompt   string `json:"prompt"`
				Expected int    `json:"expected_count"`
			}](suiteJSON)
			jobs := []Job{}
			for _, i := range rand.Perm(len(suite))[:3] {
				c := suite[i]
				if c.Prefix != "" {
					c.Prompt = c.Prefix + "\n\nFinal task:\n" + c.Prompt
				}
				jobs = append(jobs, Job{c.Prompt, c.System, c.Expected})
			}
			return jobs, nil
		}
		return nil, errors.New("未知测试或绘图版本")
	case "request":
		if q.Effort == "none" {
			q.Effort = ""
		}
		body, _ := codexTurn(q.Account, q.Model, q.Effort, q.Job.Instructions, q.Job.Prompt)
		// CPS supplies transport identity and headers; the captured context is only a request fixture.
		return body, nil
	case "score":
		if len(q.Answers) == 0 || len(q.Answers) != len(q.Jobs) {
			return nil, errors.New("样本数量不匹配")
		}
		switch q.Kind {
		case "candy":
			return map[string]any{"correct": candyAnswer.MatchString(q.Answers[0]), "rule": "standalone-21"}, nil
		case "pelican":
			code := extractCode(q.Answers[0])
			if code == "" || len(code) > 256<<10 {
				return nil, errors.New("绘图回答缺少 HTML/SVG 或超过 256 KiB")
			}
			return map[string]any{"html": code}, nil
		case "fingerprint":
			outputs := []fingerprintOutput{}
			for i, text := range q.Answers {
				nums := parseNumbers(text)
				if len(nums) > q.Jobs[i].Expected {
					nums = nums[:q.Jobs[i].Expected]
				}
				values := []string{}
				for _, n := range nums {
					values = append(values, fmt.Sprint(n))
				}
				outputs = append(outputs, fingerprintOutput{strings.Join(values, ","), q.Jobs[i].Expected})
			}
			attr, err := analyzeFingerprint(outputs)
			return map[string]any{"attribution": attr, "detector_revision": detectorRevision}, err
		}
	}
	return nil, errors.New("未知引擎操作")
}

//go:embed data/lm-detector/enrollment-suite.json
var suiteJSON []byte

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	out := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var q Input
		err := json.Unmarshal(scanner.Bytes(), &q)
		var data any
		if err == nil {
			data, err = handle(q)
		}
		if err != nil {
			_ = out.Encode(map[string]any{"ok": false, "error": err.Error()})
		} else {
			_ = out.Encode(map[string]any{"ok": true, "data": data})
		}
	}
	if scanner.Err() != nil {
		os.Exit(1)
	}
}

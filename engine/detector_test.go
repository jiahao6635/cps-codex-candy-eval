package main

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

func TestFingerprintUpstreamParity(t *testing.T) {
	// Golden results come from the pinned upstream analyzeSharedOutputs with allowPartial, as its page runs it:
	// two calibrated rankings, a partial ranking and answers that do not move like a model's.
	raw, err := os.ReadFile("testdata/lm-detector-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Outputs  []fingerprintOutput
		Expected fingerprintAttribution
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	close := func(a, b *float64) {
		t.Helper()
		if (a == nil) != (b == nil) || a != nil && !(math.Abs(*a-*b) <= 1e-9) {
			t.Fatalf("got %v, want %v", a, b)
		}
	}
	for _, tt := range cases {
		got, err := analyzeFingerprint(tt.Outputs)
		if err != nil {
			t.Fatal(err)
		}
		want := tt.Expected
		if got.Decision != want.Decision || got.Prediction != want.Prediction || got.PredictionName != want.PredictionName || got.FamilyPrediction != want.FamilyPrediction ||
			got.Used != want.Used || got.Sequence.ModelLike != want.Sequence.ModelLike || !reflect.DeepEqual(got.Diagnostics, want.Diagnostics) || len(got.Results) != len(want.Results) {
			t.Fatalf("attribution mismatch: %+v", got)
		}
		close(got.Probability, want.Probability)
		close(&got.Sequence.Autocorrelation, &want.Sequence.Autocorrelation)
		close(&got.Sequence.SmallStepShare, &want.Sequence.SmallStepShare)
		for i, r := range got.Results {
			w := want.Results[i]
			if r.Model != w.Model || r.DisplayName != w.DisplayName || r.Family != w.Family || r.FamilyName != w.FamilyName {
				t.Fatalf("rank %d: %+v, want %+v", i, r, w)
			}
			close(r.Probability, w.Probability)
			close(&r.Score, &w.Score)
		}
	}
}

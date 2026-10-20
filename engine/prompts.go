package main

const candyPrompt = `不使用任何外部工具回答以下问题：

在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形       7      9      8
五角星形   7      6      4
`

const pelicanMaxCode = 256 << 10

// pelicanPreamble opens every pelican prompt so a Codex model answers in text instead of writing a file.
const pelicanPreamble = "不使用任何工具，也不要创建或修改文件，直接在回复中完成以下任务：\n\n"

// pelicanVariant is a version of the pelican test: its prompt and the markup language the answer is written in.
type pelicanVariant struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Prompt   string `json:"prompt"`
	language string
}

var pelicanVariants = []pelicanVariant{
	// Simon Willison's pelican-on-a-bicycle test.
	{ID: "original", Label: "原版", language: "html", Prompt: pelicanPreamble +
		"创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要使用外部资产。\n\n" +
		"在一个 ```html 代码块中给出完整的 HTML 文件。"},
	// The pelican in a crowded scene, shouting the answer to the candy problem.
	{ID: "all-in-one", Label: "多合一版", language: "svg", Prompt: pelicanPreamble +
		"做一张精细的SVG图片，内容是鹈鹕骑着自行车在孙悟空开的大型飞机机翼上骑行，\n" +
		"鹈鹕展开翅膀，上面托着秦始皇的北极熊，秦始皇骑在熊上打螺丝。鹈鹕喊出\n" +
		"“在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）\n" +
		"苹果味 桃子味 西瓜味\n" +
		"圆形 7 9 8\n" +
		"五角星形 7 6 4”\n\n" +
		"的结果数值\n\n" +
		"在一个 ```svg 代码块中给出完整的 SVG 文件。"},
}

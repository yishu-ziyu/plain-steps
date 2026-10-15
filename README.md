# plain-steps

Claude Code 的一个 mod。

Claude 干活时，终端里每一步都会打出完整的命令和输出：路径、参数、JSON，一屏接一屏。要知道它做得对不对，你得自己读完这些。

plain-steps 替你读完。每一步只留一行：在做什么、用了多久、成没成。出错的那一步下面留着最后几行报错，你可以直接判断要不要插手，也能顺着报错找原因。想看细节，输入 `/steps` 切回完整输出。

![plain-steps 演示](demo.gif)

## 装上

在 Claude Code 的输入框里输入：

```
/plugin install plain-steps --marketplace yishu-ziyu/plain-steps
```

问是否添加 marketplace 时输入 `y`，再选安装范围（默认用户范围，回车即可）。装好后当场生效。

想改代码再试：克隆仓库后运行 `claude --plugin-dir ./plain-steps`。

在 Claude Code v2.1.292 上测试过。

## 一行里写什么

| 显示 | 意思 |
|---|---|
| `✓` | 这一步正常结束。超过 2 秒会写上耗时，比如 `✓ 38 秒` |
| `✗ 失败` | 这一步报错退出，下面显示输出的最后 6 行 |
| `超时，转到后台` | 命令超时，Claude Code 把它转到后台继续跑 |
| `在后台跑` | 这一步一开始就在后台运行 |
| `已中断` | 你中断了这一步 |

- 说明文字来自 Claude 给每条命令写的描述，所以语言跟着 Claude 走。
- `✓` 只表示命令正常结束。如果测试脚本在测试失败时仍然正常退出，这里也会是 `✓`。
- 只接管 Bash、Read、Edit、Write、Grep、Glob、Agent、SendMessage、ToolSearch、Skill 这几种工具，其他工具照原样显示。

## 切换

输入 `/steps`：每一步切回完整命令和输出。再输入一次：切回一行。

## 许可

MIT

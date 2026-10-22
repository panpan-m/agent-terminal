"""Generate the agent-terminal icon set (ico/png) by supersampling.

Design: dark rounded tile, emerald terminal prompt chevron, bright cursor
underscore, and a sky "agent node" dot linked to the prompt -- terminal for
humans, node for agents.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]

S = 4096  # supersampled canvas
BG = (11, 15, 13, 255)          # near-black with a green cast
CHEVRON = (52, 211, 153, 255)   # emerald-400
CURSOR = (167, 243, 208, 255)   # emerald-200
NODE = (56, 189, 248, 255)      # sky-400 (the agent accent)
LINK = (52, 211, 153, 200)


def rounded_tile(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * 0.185)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    return img


def draw_mark(draw: ImageDraw.ImageDraw, k: float) -> None:
    """Draw the prompt/cursor/node mark; k = canvas / 1024 scale factor."""
    w = int(96 * k)  # stroke width
    # terminal prompt chevron >
    draw.line(
        [(300 * k, 285 * k), (560 * k, 512 * k), (300 * k, 739 * k)],
        fill=CHEVRON,
        width=w,
        joint="curve",
    )
    # cursor underscore
    draw.rounded_rectangle(
        [596 * k, 648 * k, 828 * k, 744 * k],
        radius=w // 2,
        fill=CURSOR,
    )
    # agent node, linked to the prompt tip
    draw.line([(560 * k, 512 * k), (742 * k, 318 * k)], fill=LINK, width=int(26 * k))
    r = 62 * k
    draw.ellipse([742 * k - r, 318 * k - r, 742 * k + r, 318 * k + r], fill=NODE)


def render(size: int) -> Image.Image:
    tile = rounded_tile(S)
    draw = ImageDraw.Draw(tile)
    draw_mark(draw, S / 1024)
    return tile.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_dir = ROOT / "packaging" / "windows"
    icon = render(1024)
    icon.save(out_dir / "agent-terminal.png")
    icon.save(
        out_dir / "agent-terminal.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    # favicon png for the SPA
    pub = ROOT / "frontend" / "public"
    render(512).save(pub / "icon-512.png")
    render(64).save(pub / "icon-64.png")
    print("written:", out_dir / "agent-terminal.ico", "and favicon pngs")


if __name__ == "__main__":
    main()

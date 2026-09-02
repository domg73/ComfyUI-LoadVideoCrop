from comfy_api.latest import ComfyExtension

from .load_video_crop import LoadVideoCrop

WEB_DIRECTORY = "./web"


class LoadVideoCropExtension(ComfyExtension):
    async def get_node_list(self):
        return [LoadVideoCrop]


async def comfy_entrypoint() -> LoadVideoCropExtension:
    return LoadVideoCropExtension()

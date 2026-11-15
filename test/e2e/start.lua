-- Run inside a headless Neovim by e2e.test.js: sets up markedit.nvim and opens
-- a document, then publishes the port for the test to find.
vim.opt.rtp:prepend(vim.env.MARKEDIT_NVIM_PLUGIN)

require("markedit").setup({
    port = tonumber(vim.env.E2E_PORT),
    notify = false,
    open = function() end,
    sync = { debounce = 10 },
    autosave = { debounce = 20 },
})

vim.cmd("edit " .. vim.fn.fnameescape(vim.env.E2E_DOC))
vim.bo.filetype = "markdown"
require("markedit").open()

vim.fn.writefile({ tostring(require("markedit").status().port) }, vim.env.E2E_PORTFILE)

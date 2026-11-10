"use strict";

(function () {
    var currentKey = "kcs.workspace.current";
    var prefix = "kcs.workspace.by-id.";

    function identity(workspace) {
        return workspace.worksheet_id + "/" + String(workspace.table_id);
    }

    async function list() {
        window.workspaceSheet.requireExcel("1.9");

        return Excel.run(async function (context) {
            var settings = context.workbook.settings;
            var sheets = context.workbook.worksheets;

            settings.load("items/key,items/value");
            sheets.load("items/id,items/name");
            await context.sync();

            var found = new Map();

            function priority(item) {
                if (item.key === currentKey) return 2;
                if (item.key.indexOf(prefix) === 0) return 1;
                return 0;
            }

            settings.items
                .slice()
                .sort(function (a, b) {
                    return priority(a) - priority(b);
                })
                .forEach(function (item) {
                    var value = item.value;

                    if (
                        item.key.indexOf("kcs.workspace.") !== 0 ||
                        !value ||
                        !value.table_id ||
                        !value.worksheet_id
                    ) {
                        return;
                    }

                    var sheet = sheets.items.find(function (candidate) {
                        return candidate.id === value.worksheet_id;
                    });

                    if (!sheet) return;

                    found.set(
                        identity(value),
                        Object.assign({}, value, {
                            sheet_name: sheet.name
                        })
                    );
                });

            return Array.from(found.values());
        });
    }

    async function current() {
        return Excel.run(async function (context) {
            var setting = context.workbook.settings
                .getItemOrNullObject(currentKey);

            setting.load("value");
            await context.sync();

            return setting.isNullObject ? null : setting.value;
        });
    }

    async function save(workspace) {
        if (!workspace.workspace_id) {
            workspace.workspace_id = window.apiClient.newRequestId();
        }

        await Excel.run(async function (context) {
            context.workbook.settings.add(
                prefix + workspace.workspace_id,
                workspace
            );
            context.workbook.settings.add(currentKey, workspace);

            await context.sync();
        });
    }

    window.workspaceStore = {
        list: list,
        current: current,
        save: save,
        identity: identity
    };
})();
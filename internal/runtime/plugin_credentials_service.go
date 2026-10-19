package runtime

import (
	"context"
	"encoding/json"
	"strings"

	pluginpkg "github.com/blueberrycongee/wuu/internal/plugin"
	"github.com/blueberrycongee/wuu/internal/plugincredentials"
)

func (s *pluginHostServices) credentialRequest(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.lockContext, cancel)
	defer stop()
	defer cancel()
	var params plugincredentials.RequestParams
	if err := decodeServiceParams(raw, &params); err != nil {
		return nil, err
	}
	key, definition, err := s.ownedSetting(strings.TrimPrefix(params.Credential, s.pluginID+"."))
	if err != nil {
		return nil, err
	}
	if definition.Type != pluginpkg.SettingTypeSecret {
		return nil, serviceError("credential_not_owned", "credential must name this plugin's declared secret setting")
	}
	binding, err := plugincredentials.BindingFor(s.wuuHome, s.projectRoot, s.subjectID, key, definition.CredentialOrigins)
	if err != nil {
		return nil, serviceError("credential_unavailable", err.Error())
	}
	store, err := plugincredentials.Open()
	if err != nil {
		return nil, serviceError("credential_unavailable", err.Error())
	}
	result, err := plugincredentials.Request(ctx, store, binding, params)
	if err != nil {
		return nil, serviceError("credential_request_failed", err.Error())
	}
	return marshalServiceResult(result)
}
